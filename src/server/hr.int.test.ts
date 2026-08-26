import { randomUUID } from 'node:crypto'
import type { Principal } from '@kernhq/contracts'
import { CAPABILITIES_KEY, createKernel, type Kernel, type RequestContext, type Tx } from '@kernhq/kernel'
import { call } from '@orpc/server'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { zonedToInstant } from '../policy/time.js'
import { hrModule } from './index.js'
import { hrJobs } from './jobs.js'
import { implement_ } from './router.js'
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
import { AttendanceService, NO_SCHEDULE } from './services/attendance.js'
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
let hr: ReturnType<typeof implement_>
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
    // `attendance` is a capability, and it is off by default — every attendance procedure answers
    // 404 until a workspace switches it on. The stub says it is on, because the tests below call
    // those procedures the way a workspace that bought the feature does.
    'settings.getModule': { handler: async () => ({ [CAPABILITIES_KEY]: { attendance: true } }) },
    'settings.setModule': { handler: async () => ({ ok: true }) },
  })
}

/**
 * A request context, as the HTTP layer would build one.
 *
 * The router is the only place three things live: `workspaceScoped`, the capability gate, and the
 * punch guard that answers "You are not clocked in." Nothing below the router can reach them, which
 * is why the attendance tests construct it rather than calling `AttendanceService` directly.
 */
const asUser = (userId: string, workspaceId = WS_A): RequestContext => ({
  kernel,
  principal: principal(userId, workspaceId),
  requestId: randomUUID(),
  ip: '127.0.0.1',
  headers: {},
})

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
  hr = implement_(kernel)
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
      await attendanceSvc.record(tx, WS_A, {
        personId: emre,
        direction: 'in',
        at: new Date(zonedToInstant('2026-03-20', '09:00', IST)),
        businessDate: '2026-03-20',
        timezone: IST,
        method: 'manual',
        claimed: true,
      })
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
        await attendanceSvc.record(tx, WS_A, {
          personId: lale,
          direction,
          at: new Date(zonedToInstant('2026-06-05', wall, IST)),
          businessDate: '2026-06-05',
          timezone: IST,
          method: 'manual',
          claimed: true,
        })
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
    const punch = await run(async (tx) => {
      // Attributed rather than asserted into place: `record` no longer works out the business date
      // for itself, so the date it stores is only right if `attribute` is the thing that chose it.
      const at = new Date(Date.UTC(2026, 6, 15, 6, 0))
      const { businessDate } = await attendanceSvc.attribute(
        tx,
        WS_A,
        mert,
        at.getTime(),
        'Europe/Istanbul',
        NO_SCHEDULE,
      )
      return attendanceSvc.record(tx, WS_A, {
        personId: mert,
        direction: 'in',
        at,
        businessDate,
        timezone: 'Europe/Istanbul',
        method: 'manual',
        claimed: true,
      })
    })
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
 * The rotating week, clocked through the real procedures.
 *
 * Nights 22:00–06:00 Monday to Friday and 08:00–16:00 on Saturday, in New York, on a real
 * `schedules` row read back through `AttendanceService.scheduleFor` and a real
 * `schedule_assignments` row. Everything here goes through `attendance.clockIn`, `clockOut` and
 * `state`, because the three things this bug has broken twice are the three things nothing below
 * the router can reach:
 *
 * - `clockContext`, which attributes **the current instant** and has to agree with what `record`
 *   then does with it — when the two disagree, the punches of one shift land on two sheets;
 * - the guard that answers `You are not clocked in.`, which is what that disagreement actually
 *   costs somebody at the end of their day;
 * - `attendance.state`, which is the only thing the clock widget asks and therefore the only place
 *   a person sees the answer before it bites them.
 *
 * The clock is faked rather than claimed. `record`'s `claimedAt` is a parameter no production
 * caller passes, so a test that sets it drives a path a user cannot reach — and it goes round
 * `clockContext`, which is exactly where both failures lived.
 */
describe('a rotating week, clocked through the router', () => {
  const attendanceSvc = new AttendanceService()
  const NY = 'America/New_York'
  const NIGHT = { start: '22:00', end: '06:00', breakMinutes: 0 }
  const MORNING = { start: '08:00', end: '16:00', breakMinutes: 0 }
  const FRIDAY = '2026-06-19'
  const SATURDAY = '2026-06-20'

  /** Somebody on the rotating schedule, with their own zone and a real assignment to it. */
  const hire = async (displayName: string) => {
    const personId = randomUUID()
    const userId = randomUUID()
    await run(async (tx) => {
      const [schedule] = await tx
        .insert(schedules)
        .values({
          workspaceId: WS_A,
          name: `Rotating (${displayName})`,
          kind: 'shift',
          week: { mon: NIGHT, tue: NIGHT, wed: NIGHT, thu: NIGHT, fri: NIGHT, sat: MORNING, sun: null },
          graceInMinutes: 5,
          graceOutMinutes: 5,
        })
        .returning()
      await tx.insert(people).values({
        id: personId,
        workspaceId: WS_A,
        userId,
        displayName,
        // Their own zone rather than the workspace's Istanbul office: this is a New York roster, and
        // the resolution ladder prefers a person's override over their office.
        timezone: NY,
      })
      await tx.insert(scheduleAssignments).values({
        workspaceId: WS_A,
        personId,
        scheduleId: schedule!.id,
        effectiveFrom: '2020-01-01',
      })
    })
    return { personId, userId }
  }

  /** Move the server's clock. Everything the router reads — `Date.now()` included — follows it. */
  const clockReads = (date: string, wall: string) =>
    vi.setSystemTime(new Date(zonedToInstant(date, wall, NY)))

  const clockIn = (userId: string) =>
    call(hr.attendance.clockIn, { workspaceId: WS_A }, { context: asUser(userId) })
  const clockOut = (userId: string) =>
    call(hr.attendance.clockOut, { workspaceId: WS_A }, { context: asUser(userId) })
  const state = (userId: string) =>
    call(hr.attendance.state, { workspaceId: WS_A }, { context: asUser(userId) })

  const sheet = (personId: string, businessDate: string) =>
    run(async (tx) => {
      const [row] = await tx
        .select()
        .from(attendanceDays)
        .where(
          and(
            eq(attendanceDays.workspaceId, WS_A),
            eq(attendanceDays.personId, personId),
            eq(attendanceDays.businessDate, businessDate),
          ),
        )
      return row
    })

  /**
   * The same schedule and the same zone for as many people as a sweep needs, in one transaction.
   *
   * `hire` is fine for two people and is twelve hundred round trips for four hundred, which is long
   * enough that somebody would trim the sweep instead.
   */
  const hireMany = async (names: string[]) => {
    const cast = names.map((displayName) => ({
      personId: randomUUID(),
      userId: randomUUID(),
      displayName,
    }))
    await run(async (tx) => {
      const [schedule] = await tx
        .insert(schedules)
        .values({
          workspaceId: WS_A,
          name: `Rotating (${cast[0]?.displayName ?? 'cast'})`,
          kind: 'shift',
          week: { mon: NIGHT, tue: NIGHT, wed: NIGHT, thu: NIGHT, fri: NIGHT, sat: MORNING, sun: null },
          graceInMinutes: 5,
          graceOutMinutes: 5,
        })
        .returning()
      await tx.insert(people).values(
        cast.map((c) => ({
          id: c.personId,
          workspaceId: WS_A,
          userId: c.userId,
          displayName: c.displayName,
          timezone: NY,
        })),
      )
      await tx.insert(scheduleAssignments).values(
        cast.map((c) => ({
          workspaceId: WS_A,
          personId: c.personId,
          scheduleId: schedule!.id,
          effectiveFrom: '2020-01-01',
        })),
      )
    })
    return cast.map((c) => ({ personId: c.personId, userId: c.userId }))
  }

  /** Every sheet this cast has, keyed `personId|businessDate`. One query rather than one per row. */
  const sheetsFor = async (personIds: string[]) => {
    const rows = await run((tx) =>
      tx
        .select()
        .from(attendanceDays)
        .where(and(eq(attendanceDays.workspaceId, WS_A), inArray(attendanceDays.personId, personIds))),
    )
    return new Map(rows.map((r) => [`${r.personId}|${r.businessDate}`, r]))
  }

  /** How many live punches each of them has on one business date. */
  const punchCountsOn = async (personIds: string[], businessDate: string) => {
    const rows = await run((tx) =>
      tx
        .select({ personId: punches.personId })
        .from(punches)
        .where(
          and(
            eq(punches.workspaceId, WS_A),
            inArray(punches.personId, personIds),
            eq(punches.businessDate, businessDate),
            isNull(punches.voidedByPunchId),
          ),
        ),
    )
    const counts = new Map<string, number>()
    for (const row of rows) counts.set(row.personId, (counts.get(row.personId) ?? 0) + 1)
    return counts
  }

  const wallMinutes = (wall: string) => {
    const [hour, minute] = wall.split(':').map(Number) as [number, number]
    return hour * 60 + minute
  }

  let early: { personId: string; userId: string }
  let late: { personId: string; userId: string }

  beforeAll(async () => {
    early = await hire('Early Sena')
    late = await hire('Late Deniz')
    // Faked only once the fixtures are in, so those rows are stamped by the real clock. `Date` and
    // nothing else: the pg driver's own timeouts are real timers and must keep running.
    vi.useFakeTimers({ toFake: ['Date'] })
  }, 60_000)

  afterAll(() => {
    vi.useRealTimers()
  })

  describe('arriving eight minutes early for the Saturday morning', () => {
    it('files Friday night on Friday, both ends of it', async () => {
      clockReads(FRIDAY, '22:00')
      expect((await clockIn(early.userId)).businessDate).toBe(FRIDAY)
      clockReads(SATURDAY, '06:00')
      expect((await clockOut(early.userId)).businessDate).toBe(FRIDAY)

      const friday = await sheet(early.personId, FRIDAY)
      expect(friday?.workedMinutes).toBe(480)
      expect(friday?.status).toBe('present')
      expect(friday?.anomalies).toEqual([])
    })

    it('files a 07:52 clock-in on Saturday, not on the night that has just ended', async () => {
      // The reported defect. 07:52 is inside the tail of Friday's night, and cutting the tail at
      // Saturday's start exactly — 08:00:00, to the second — sent this punch to Friday.
      clockReads(SATURDAY, '07:52')
      expect((await clockIn(early.userId)).businessDate).toBe(SATURDAY)
    })

    it('shows the clock running on Saturday when the widget asks at 09:00', async () => {
      clockReads(SATURDAY, '09:00')
      const now = await state(early.userId)
      expect(now.businessDate).toBe(SATURDAY)
      expect(now.clockedIn).toBe(true)
      // Sixty-eight minutes since 07:52, counted up to the moment of asking.
      expect(now.workedMinutesToday).toBe(68)
    })

    it('lets them clock out at 16:00 instead of refusing it', async () => {
      // This is what the split actually cost: `punchesOn(Saturday)` was empty, so the guard threw
      // `You are not clocked in.` and a morning shift after a night week could not be ended.
      clockReads(SATURDAY, '16:00')
      expect((await clockOut(early.userId)).businessDate).toBe(SATURDAY)

      const saturday = await sheet(early.personId, SATURDAY)
      expect(saturday?.workedMinutes).toBe(488)
      expect(saturday?.status).toBe('present')
      expect(saturday?.anomalies).toEqual([])
      expect(saturday?.lateMinutes).toBe(0)
    })

    it('leaves the finished night exactly as it was', async () => {
      // The other half of the damage: the early punch landed on Friday as a third punch, so a night
      // that had been closed correctly went back to `pending` with a missing clock-out against it.
      const friday = await sheet(early.personId, FRIDAY)
      expect(friday?.workedMinutes).toBe(480)
      expect(friday?.status).toBe('present')
      expect(friday?.anomalies).toEqual([])
      expect((await run((tx) => attendanceSvc.punchesOn(tx, WS_A, early.personId, FRIDAY))).length).toBe(2)
    })
  })

  /**
   * The case adjacent to the reported one: the mirror of arriving early is leaving late.
   *
   * Moving the boundary earlier to let an early arrival through takes those minutes away from the
   * night's overtime, so the same test has to be run from the other end. Forty-five minutes past a
   * 06:00 finish is still the night's — and the morning that follows it still has to work.
   */
  describe('leaving forty-five minutes late off the Friday night', () => {
    it('keeps both ends of the overtime on Friday', async () => {
      clockReads(FRIDAY, '22:00')
      expect((await clockIn(late.userId)).businessDate).toBe(FRIDAY)
      clockReads(SATURDAY, '06:45')
      expect((await clockOut(late.userId)).businessDate).toBe(FRIDAY)

      const friday = await sheet(late.personId, FRIDAY)
      expect(friday?.workedMinutes).toBe(525)
      expect(friday?.overtimeMinutes).toBe(45)
      expect(friday?.status).toBe('present')
      expect(friday?.anomalies).toEqual([])
    })

    it('still lets the Saturday morning be clocked, start to finish', async () => {
      clockReads(SATURDAY, '08:00')
      expect((await clockIn(late.userId)).businessDate).toBe(SATURDAY)
      clockReads(SATURDAY, '16:00')
      expect((await clockOut(late.userId)).businessDate).toBe(SATURDAY)

      const saturday = await sheet(late.personId, SATURDAY)
      expect(saturday?.workedMinutes).toBe(480)
      expect(saturday?.anomalies).toEqual([])
    })

    it('never had Saturday holding a punch that belonged to the night', async () => {
      const rows = await run((tx) => attendanceSvc.punchesOn(tx, WS_A, late.personId, SATURDAY))
      expect(rows.map((r) => r.direction)).toEqual(['in', 'out'])
    })
  })

  /**
   * Every minute of the contested morning, through the real router, read three ways.
   *
   * The three rounds before this one each shipped with tests that checked chosen instants — 07:52,
   * then 07:00 — and each time a skeptic found the failure one minute away from whichever instant
   * had been chosen. So this does not choose. It walks 06:00 to 08:15 a minute at a time and puts
   * three different people through each one:
   *
   * - **overran** clocked in at 22:00 and never clocked out, so their punch is a departure;
   * - **arrived** did not work the night at all, so their punch is an arrival;
   * - **finished** worked the night and closed it at 06:00, so their punch is an arrival too — and
   *   the night they already filed must read exactly as it did before they made it.
   *
   * Nothing here asserts a boundary, because there is no longer one to assert. What is asserted is
   * that both ends of every shift land on the same day and that no punch is refused — which is what
   * the defect actually costs somebody, and what no single-instant test can see.
   */
  describe('every minute from 06:00 to 08:15', () => {
    const window: string[] = []
    for (let minute = 6 * 60; minute <= 8 * 60 + 15; minute++)
      window.push(
        `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`,
      )

    /** One person's punches through one minute of the window: what each was filed on, in order. */
    interface Run {
      wall: string
      personId: string
      filed: Array<string | null>
    }

    /** A refusal is collected, never thrown: one bad minute must not hide the other hundred. */
    const refusals: string[] = []
    const overran: Run[] = []
    const arrived: Run[] = []
    const finished: Run[] = []

    const tryPunch = async (label: string, punch: () => Promise<{ businessDate: string }>) => {
      try {
        return (await punch()).businessDate
      } catch (error) {
        refusals.push(`${label} — ${(error as Error).message}`)
        return null
      }
    }

    beforeAll(async () => {
      // One schedule and one transaction for the whole cast: 408 people hired one at a time is
      // several hundred round trips before the first assertion.
      const cast = await hireMany(
        window.flatMap((wall) => [`overran ${wall}`, `arrived ${wall}`, `finished ${wall}`]),
      )

      for (const [index, wall] of window.entries()) {
        const a = cast[index * 3]!
        const b = cast[index * 3 + 1]!
        const c = cast[index * 3 + 2]!
        const runA: Run = { wall, personId: a.personId, filed: [] }
        const runB: Run = { wall, personId: b.personId, filed: [] }
        const runC: Run = { wall, personId: c.personId, filed: [] }

        clockReads(FRIDAY, '22:00')
        runA.filed.push(await tryPunch(`overran ${wall}: in`, () => clockIn(a.userId)))
        runC.filed.push(await tryPunch(`finished ${wall}: in`, () => clockIn(c.userId)))

        clockReads(SATURDAY, '06:00')
        runC.filed.push(await tryPunch(`finished ${wall}: out`, () => clockOut(c.userId)))

        clockReads(SATURDAY, wall)
        runA.filed.push(await tryPunch(`overran ${wall}: out`, () => clockOut(a.userId)))
        runB.filed.push(await tryPunch(`arrived ${wall}: in`, () => clockIn(b.userId)))
        // At 06:00 exactly this would be the same instant as the clock-out above, and two punches
        // sharing an instant have no order — a different question, and one nothing user-facing can
        // reach. Their arrival starts a minute later.
        if (wall !== '06:00')
          runC.filed.push(await tryPunch(`finished ${wall}: in again`, () => clockIn(c.userId)))

        // The night is closed now, so the person who overran it still has a morning to work.
        clockReads(SATURDAY, '08:30')
        runA.filed.push(await tryPunch(`overran ${wall}: in again`, () => clockIn(a.userId)))

        clockReads(SATURDAY, '16:00')
        runA.filed.push(await tryPunch(`overran ${wall}: out again`, () => clockOut(a.userId)))
        runB.filed.push(await tryPunch(`arrived ${wall}: out`, () => clockOut(b.userId)))
        if (wall !== '06:00')
          runC.filed.push(await tryPunch(`finished ${wall}: out again`, () => clockOut(c.userId)))

        overran.push(runA)
        arrived.push(runB)
        finished.push(runC)
      }
    }, 600_000)

    /**
     * The case the sweep cannot reach, because its finished night closes at 06:00.
     *
     * A night worked 22:00–05:30 and clocked out of is *closed*, so nothing is open — and the rule
     * that hands the small hours to the previous night fired anyway. Somebody arriving at 05:50 for
     * the Saturday morning joined a Friday that had already finished: four punches on it, 1060
     * worked minutes where there had been 450, and nine hours of overtime nobody worked. A skeptic
     * measured it through the router; the doc comment above `attributeToShift` had promised a
     * finished day could not be disturbed.
     */
    it('leaves a night that finished early exactly as it was when somebody arrives before its end', async () => {
      const [worker] = await hireMany(['closed early, arrives at 05:50'])
      const filed: Array<string | null> = []

      clockReads(FRIDAY, '22:00')
      filed.push(await tryPunch('closed-early: in', () => clockIn(worker!.userId)))
      clockReads(SATURDAY, '05:30')
      filed.push(await tryPunch('closed-early: out', () => clockOut(worker!.userId)))

      const before = await run((tx) =>
        tx
          .select()
          .from(attendanceDays)
          .where(and(eq(attendanceDays.personId, worker!.personId), eq(attendanceDays.businessDate, FRIDAY))),
      )
      expect(before[0]?.workedMinutes, 'the night as worked').toBe(450)

      // Two hours and ten minutes early for the 08:00 morning, and inside the night's own span.
      clockReads(SATURDAY, '05:50')
      filed.push(await tryPunch('closed-early: in again', () => clockIn(worker!.userId)))
      clockReads(SATURDAY, '16:00')
      filed.push(await tryPunch('closed-early: out again', () => clockOut(worker!.userId)))

      expect(filed).toEqual([FRIDAY, FRIDAY, SATURDAY, SATURDAY])

      const after = await run((tx) =>
        tx
          .select()
          .from(attendanceDays)
          .where(and(eq(attendanceDays.personId, worker!.personId), eq(attendanceDays.businessDate, FRIDAY))),
      )
      expect(after[0]?.workedMinutes, 'the finished night is untouched').toBe(450)
      expect(after[0]?.status).toBe('present')
      expect(after[0]?.anomalies).toEqual([])
    }, 60_000)

    it('sweeps the whole window rather than a handful of chosen minutes', () => {
      expect(window).toHaveLength(136)
      expect(window[0]).toBe('06:00')
      expect(window.at(-1)).toBe('08:15')
      expect(overran).toHaveLength(136)
      expect(arrived).toHaveLength(136)
      expect(finished).toHaveLength(136)
    })

    it('refuses nothing, at any minute, in any of the three readings', () => {
      // Round three refused a night worker's 07:05 clock-out outright and left them no way to
      // record it. Every refusal in the window is listed here rather than only the first.
      expect(refusals).toEqual([])
    })

    it('files a night somebody overran on the night, and the morning after it on the morning', () => {
      for (const run of overran)
        expect(run.filed, `overran ${run.wall}`).toEqual([FRIDAY, FRIDAY, SATURDAY, SATURDAY])
    })

    it('files an arrival by somebody who never worked the night entirely on the morning', () => {
      for (const run of arrived) expect(run.filed, `arrived ${run.wall}`).toEqual([SATURDAY, SATURDAY])
    })

    it('files an arrival after a finished night on the morning, both ends of it', () => {
      for (const run of finished)
        expect(run.filed, `finished ${run.wall}`).toEqual(
          run.wall === '06:00' ? [FRIDAY, FRIDAY] : [FRIDAY, FRIDAY, SATURDAY, SATURDAY],
        )
    })

    /**
     * The sheets, read in two queries rather than 816.
     *
     * Landing on the right date is only half of it: the figures have to be the ones somebody would
     * be paid on, and the night that was already finished has to be untouched by whatever happened
     * the next morning.
     */
    it('adds the overrun to the night and leaves the morning a normal shift', async () => {
      const days = await sheetsFor(overran.map((r) => r.personId))
      for (const run of overran) {
        const minute = wallMinutes(run.wall)
        const night = days.get(`${run.personId}|${FRIDAY}`)
        expect(night?.workedMinutes, `overran ${run.wall} night`).toBe(480 + (minute - 6 * 60))
        expect(night?.status, `overran ${run.wall} night`).toBe('present')
        expect(night?.anomalies, `overran ${run.wall} night`).toEqual([])
        expect(night?.overtimeMinutes, `overran ${run.wall} night`).toBe(minute - 6 * 60)

        const morning = days.get(`${run.personId}|${SATURDAY}`)
        // 08:30 to 16:00, thirty minutes late against an 08:00 start with five minutes of grace.
        expect(morning?.workedMinutes, `overran ${run.wall} morning`).toBe(450)
        expect(morning?.status, `overran ${run.wall} morning`).toBe('present')
        expect(morning?.anomalies, `overran ${run.wall} morning`).toEqual([])
        expect(morning?.lateMinutes, `overran ${run.wall} morning`).toBe(25)
      }
    })

    it('puts an early arrival on the morning it is early for, and nothing on the night', async () => {
      const days = await sheetsFor(arrived.map((r) => r.personId))
      for (const run of arrived) {
        const minute = wallMinutes(run.wall)
        expect(days.get(`${run.personId}|${FRIDAY}`), `arrived ${run.wall} night`).toBeUndefined()
        const morning = days.get(`${run.personId}|${SATURDAY}`)
        expect(morning?.workedMinutes, `arrived ${run.wall}`).toBe(16 * 60 - minute)
        expect(morning?.status, `arrived ${run.wall}`).toBe('present')
        expect(morning?.anomalies, `arrived ${run.wall}`).toEqual([])
      }
    })

    it('leaves a night that already read 480/present/[] reading exactly that', async () => {
      const days = await sheetsFor(finished.map((r) => r.personId))
      const punchCounts = await punchCountsOn(
        finished.map((r) => r.personId),
        FRIDAY,
      )
      for (const run of finished) {
        const night = days.get(`${run.personId}|${FRIDAY}`)
        expect(night?.workedMinutes, `finished ${run.wall}`).toBe(480)
        expect(night?.status, `finished ${run.wall}`).toBe('present')
        expect(night?.anomalies, `finished ${run.wall}`).toEqual([])
        // Two punches, not three: the arrival that follows must not land on the night's sheet, which
        // is how a closed night went back to `pending` in round two.
        expect(punchCounts.get(run.personId) ?? 0, `finished ${run.wall}`).toBe(2)

        if (run.wall === '06:00') continue
        const morning = days.get(`${run.personId}|${SATURDAY}`)
        expect(morning?.workedMinutes, `finished ${run.wall} morning`).toBe(16 * 60 - wallMinutes(run.wall))
        expect(morning?.anomalies, `finished ${run.wall} morning`).toEqual([])
      }
    })
  })

  /**
   * Somebody who forgot to clock out, on a schedule with no auto clock-out to rescue them.
   *
   * An open shift claims the next punch, so this is the one way the rule could stand somebody up:
   * arrive on Saturday, be told the punch belongs to Friday, and have no way forward. It does not,
   * because `attendance.state` reads the same attribution the guard does — the widget says they are
   * still on Friday night, the action it offers is the one the guard accepts, and the punch after it
   * is an ordinary arrival.
   */
  describe('a night nobody clocked out of, and the morning after it', () => {
    let forgetful: { personId: string; userId: string }

    beforeAll(async () => {
      const [person] = await hireMany(['Forgetful Kaan'])
      forgetful = person!
      clockReads(FRIDAY, '22:00')
      await clockIn(forgetful.userId)
    }, 60_000)

    it('tells them at 09:00 on Saturday that they are still on Friday night', async () => {
      clockReads(SATURDAY, '09:00')
      const now = await state(forgetful.userId)
      expect(now.businessDate).toBe(FRIDAY)
      expect(now.clockedIn).toBe(true)
      // Eleven hours, counted from 22:00 — visibly wrong to a person, which is the point of showing
      // it rather than silently starting a fresh day underneath them.
      expect(now.workedMinutesToday).toBe(11 * 60)
    })

    it('refuses a second clock-in, because the first one is still open', async () => {
      clockReads(SATURDAY, '09:00')
      await expect(clockIn(forgetful.userId)).rejects.toThrow('You are already clocked in.')
    })

    it('lets the clock-out they are offered close Friday, and the next punch open Saturday', async () => {
      clockReads(SATURDAY, '09:00')
      expect((await clockOut(forgetful.userId)).businessDate).toBe(FRIDAY)
      expect((await state(forgetful.userId)).clockedIn).toBe(false)
      clockReads(SATURDAY, '09:01')
      expect((await clockIn(forgetful.userId)).businessDate).toBe(SATURDAY)
      clockReads(SATURDAY, '16:00')
      expect((await clockOut(forgetful.userId)).businessDate).toBe(SATURDAY)

      const night = await sheet(forgetful.personId, FRIDAY)
      expect(night?.workedMinutes).toBe(11 * 60)
      expect(night?.anomalies).toEqual([])
      const morning = await sheet(forgetful.personId, SATURDAY)
      expect(morning?.workedMinutes).toBe(419)
    })
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
 * The nightly reconcile, and the row it was not allowed to look at.
 *
 * `attendance_days.locked` is a cache of a question only a period can answer, and `recomputeDay`
 * repairs it in both directions. But the sweep that is supposed to run `recomputeDay` over recent
 * days selected `locked = false` — so the one row class the downward repair exists for was the one
 * class the query excluded, and a day frozen with nothing behind it stayed frozen for ever. A repair
 * nothing running can reach is not a repair; it survived two rounds because the test that proved it
 * called the service method directly. This one drives `hrJobs()`'s handler, which is what a running
 * instance actually executes.
 */
describe('the nightly reconcile', () => {
  const IST = 'Europe/Istanbul'
  /** The sweep looks back fourteen days, so these dates have to be relative to the real clock. */
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
  const stuckOn = daysAgo(3)
  const filedOn = daysAgo(5)
  let stuck: string
  let filed: string

  const reconcile = () => {
    const job = hrJobs().find((j) => j.name === 'reconcile-days')
    if (!job) throw new Error('reconcile-days job is gone')
    return job.handler({}, { kernel, id: 'test', attempt: 1 })
  }

  const sheet = (personId: string, businessDate: string) =>
    run(async (tx) => {
      const [row] = await tx
        .select()
        .from(attendanceDays)
        .where(
          and(
            eq(attendanceDays.workspaceId, WS_A),
            eq(attendanceDays.personId, personId),
            eq(attendanceDays.businessDate, businessDate),
          ),
        )
      return row
    })

  beforeAll(async () => {
    stuck = randomUUID()
    filed = randomUUID()
    await run(async (tx) => {
      await tx.insert(people).values([
        { id: stuck, workspaceId: WS_A, displayName: 'Stuck', timezone: IST },
        { id: filed, workspaceId: WS_A, displayName: 'Filed', timezone: IST },
      ])
      // Six hours actually worked, on both days.
      for (const [personId, date] of [
        [stuck, stuckOn],
        [filed, filedOn],
      ] as const)
        await tx.insert(punches).values([
          {
            workspaceId: WS_A,
            personId,
            direction: 'in',
            at: new Date(zonedToInstant(date, '09:00', IST)),
            businessDate: date,
            timezone: IST,
          },
          {
            workspaceId: WS_A,
            personId,
            direction: 'out',
            at: new Date(zonedToInstant(date, '15:00', IST)),
            businessDate: date,
            timezone: IST,
          },
        ])
      // Both sheets carry `locked` and a figure that never came from those punches. Only one of them
      // has a period behind it.
      await tx.insert(attendanceDays).values([
        {
          workspaceId: WS_A,
          personId: stuck,
          businessDate: stuckOn,
          status: 'present',
          workedMinutes: 480,
          locked: true,
        },
        {
          workspaceId: WS_A,
          personId: filed,
          businessDate: filedOn,
          status: 'present',
          workedMinutes: 480,
          locked: true,
        },
      ])
      // `kind: 'attendance'` rather than `payroll` on purpose: the exclusion constraint keys on the
      // kind, and every other period in this file is a `payroll` one on a fixed 2026 date. These
      // dates move with the calendar, so a fixture on the same kind would collide with one of them
      // whenever the suite happened to run inside that month.
      await tx.insert(periods).values({
        workspaceId: WS_A,
        kind: 'attendance',
        startsOn: filedOn,
        endsOn: filedOn,
        status: 'locked',
        lockedAt: new Date(),
      })
    })
  }, 60_000)

  it('visits a day flagged locked with no period behind it, and rebuilds it', async () => {
    await reconcile()
    const day = await sheet(stuck, stuckOn)
    // Six hours from the punches, not the 480 the frozen row was carrying.
    expect(day?.workedMinutes).toBe(360)
    expect(day?.locked).toBe(false)
  })

  it('still leaves a day a period really does close exactly where it was', async () => {
    // The case adjacent to the one above, and the reason the flag was filtered on in the first
    // place. Offering every row to `recomputeDay` must not mean rewriting a filed month: the period
    // is asked, and it says no.
    const day = await sheet(filed, filedOn)
    expect(day?.workedMinutes).toBe(480)
    expect(day?.locked).toBe(true)
  })

  it('is idempotent, so a second night changes nothing', async () => {
    await reconcile()
    expect((await sheet(stuck, stuckOn))?.workedMinutes).toBe(360)
    expect((await sheet(filed, filedOn))?.workedMinutes).toBe(480)
  })
})

/**
 * The scheduled jobs, in each office's own calendar.
 *
 * The file they live in has said for months that they "fan out per office, deciding for each
 * whether that office's local boundary has passed", and no handler read the offices table:
 * `offices` and `todayIn` were imported, used nowhere, and re-exported at the bottom so the unused
 * import would not fail lint. `accrue-leave` derived its period from `date_trunc('month', now())` —
 * the database session's timezone — so a New York office was credited January's accrual at 21:00 on
 * 31 January local, and `carry-forward` converted a cap in *days* at a hardcoded eight hours.
 *
 * None of that was ever asserted, because nothing had invoked either handler: the carry-forward
 * tests called the pure function and hand-wrote the ledger entries they then read back. So this
 * drives `hrJobs()` itself, against a real database and a clock this file moves, in a workspace with
 * two offices eight hours apart. Every boundary below is checked twice — once at the instant only
 * Istanbul has crossed it, and once at the instant New York has.
 */
describe("the jobs, in each office's own calendar", () => {
  const WS_JOBS = randomUUID()
  const IST = 'Europe/Istanbul'
  const NY = 'America/New_York'
  /** Seven and a half hours. The whole point: eight is an assumption, not a fact about a workday. */
  const DAY = 450
  const svcLedger = new LedgerService()
  const inJobsWs = inWs(WS_JOBS)

  let istanbul: string
  let newYork: string
  let annual: string
  /** Istanbul: carries, accrues, and lets the carry lapse untouched. */
  let sena: string
  /** New York, the same in every respect except the eight hours between them. */
  let dana: string
  /** Istanbul, and spends part of the carry before the deadline. */
  let spender: string
  /** Istanbul until the end of June, New York from July. */
  let moved: string

  const runJob = (name: string) => {
    const job = hrJobs().find((j) => j.name === name)
    if (!job) throw new Error(`the ${name} job is gone`)
    return job.handler({}, { kernel, id: 'test', attempt: 1 })
  }
  const clockReads = (instant: string) => vi.setSystemTime(new Date(instant))

  const entries = (personId: string, periodYear: number) =>
    inJobsWs((tx) =>
      tx
        .select()
        .from(leaveLedger)
        .where(
          and(
            eq(leaveLedger.workspaceId, WS_JOBS),
            eq(leaveLedger.personId, personId),
            eq(leaveLedger.periodYear, periodYear),
          ),
        ),
    )

  const minutes = async (personId: string, periodYear: number) =>
    (await entries(personId, periodYear)).reduce((sum, e) => sum + e.amountMinutes, 0)

  const kindsOf = async (personId: string, periodYear: number) =>
    (await entries(personId, periodYear)).map((e) => e.kind).sort()

  beforeAll(async () => {
    const ids = await inJobsWs(async (tx) => {
      const [ist] = await tx
        .insert(offices)
        .values({ workspaceId: WS_JOBS, name: 'Istanbul', country: 'TR', timezone: IST, isDefault: true })
        .returning()
      const [nyc] = await tx
        .insert(offices)
        .values({ workspaceId: WS_JOBS, name: 'New York', country: 'US', timezone: NY, isDefault: false })
        .returning()
      const [type] = await tx
        .insert(leaveTypes)
        .values({ workspaceId: WS_JOBS, key: 'annual', name: 'Annual leave', paid: true, unit: 'day' })
        .returning()

      const assign = async (
        config: Record<string, unknown>,
        kind: 'accrual' | 'carry_forward',
        name: string,
      ) => {
        const [policy] = await tx
          .insert(policies)
          .values({
            workspaceId: WS_JOBS,
            kind,
            name,
            config,
            effectiveFrom: '2020-01-01',
            configHash: hashConfig(config),
          })
          .returning()
        await tx.insert(policyAssignments).values({
          workspaceId: WS_JOBS,
          policyId: policy!.id,
          subjectKind: 'workspace',
          effectiveFrom: '2020-01-01',
          priority: PolicyService.priorityFor('workspace'),
        })
      }

      // The day length lives on the accrual policy and nowhere else, which is why carry-forward has
      // to resolve it: `CarryForwardConfig` gives a cap in days and nothing to multiply it by.
      await assign(
        {
          frequency: 'monthly',
          daysPerYear: 24,
          minutesPerDay: DAY,
          seniorityTiers: [],
          waitingPeriodMonths: 0,
          calendar: 'gregorian',
          roundToMinutes: 0,
          leaveTypeKey: 'annual',
        },
        'accrual',
        'Twenty-four days on a seven-and-a-half-hour day',
      )
      await assign(
        { leaveTypeKey: 'annual', maxDays: 5, expiresAfterMonths: 3 },
        'carry_forward',
        'Five days, three months to use them',
      )

      const hire = async (displayName: string, officeId: string) => {
        const [person] = await tx
          .insert(people)
          .values({ workspaceId: WS_JOBS, displayName, hiredOn: '2020-01-01', status: 'active' })
          .returning()
        await tx.insert(officeAssignments).values({
          workspaceId: WS_JOBS,
          personId: person!.id,
          officeId,
          isPrimary: true,
          effectiveFrom: '2020-01-01',
        })
        await tx
          .insert(employments)
          .values({ workspaceId: WS_JOBS, personId: person!.id, effectiveFrom: '2020-01-01', fte: '1.000' })
        return person!.id
      }

      const senaId = await hire('Sena in Istanbul', ist!.id)
      const danaId = await hire('Dana in New York', nyc!.id)
      const spenderId = await hire('Spender in Istanbul', ist!.id)

      // Somebody who transferred. The office assignment ends; the punches it covered do not.
      const [transferred] = await tx
        .insert(people)
        .values({ workspaceId: WS_JOBS, displayName: 'Moved in July', hiredOn: '2020-01-01' })
        .returning()
      await tx.insert(officeAssignments).values([
        {
          workspaceId: WS_JOBS,
          personId: transferred!.id,
          officeId: ist!.id,
          isPrimary: true,
          effectiveFrom: '2020-01-01',
          effectiveTo: '2026-06-30',
        },
        {
          workspaceId: WS_JOBS,
          personId: transferred!.id,
          officeId: nyc!.id,
          isPrimary: true,
          effectiveFrom: '2026-07-01',
        },
      ])
      const [schedule] = await tx
        .insert(schedules)
        .values({ workspaceId: WS_JOBS, name: 'Ten hours and out', autoClockOutAfterMinutes: 600 })
        .returning()
      await tx.insert(scheduleAssignments).values({
        workspaceId: WS_JOBS,
        personId: transferred!.id,
        scheduleId: schedule!.id,
        effectiveFrom: '2020-01-01',
      })

      // Nine days standing at the end of 2025, for everybody the year turns under.
      for (const personId of [senaId, danaId, spenderId]) {
        await svcLedger.lockAndRead(tx, WS_JOBS, personId, type!.id, 2025)
        await svcLedger.append(tx, WS_JOBS, {
          personId,
          leaveTypeId: type!.id,
          kind: 'grant',
          amountMinutes: 9 * DAY,
          effectiveOn: '2025-01-01',
          periodYear: 2025,
        })
      }

      return {
        istanbul: ist!.id,
        newYork: nyc!.id,
        annual: type!.id,
        sena: senaId,
        dana: danaId,
        spender: spenderId,
        moved: transferred!.id,
      }
    })
    istanbul = ids.istanbul
    newYork = ids.newYork
    annual = ids.annual
    sena = ids.sena
    dana = ids.dana
    spender = ids.spender
    moved = ids.moved

    // Faked only once the fixtures are in, so those rows are stamped by the real clock. `Date` and
    // nothing else: the pg driver's own timeouts are real timers and must keep running.
    vi.useFakeTimers({ toFake: ['Date'] })
  }, 60_000)

  afterAll(() => {
    vi.useRealTimers()
  })

  describe('the turn of the entitlement year', () => {
    it('carries for the office that has reached 2 January, and not for the one eight hours behind', async () => {
      // 01:00 on the 2nd in Istanbul; still 17:00 on the 1st in New York.
      clockReads('2026-01-01T22:00:00Z')
      await runJob('carry-forward')

      expect(await minutes(sena, 2025)).toBe(0)
      expect(await kindsOf(sena, 2025)).toEqual(['carry_out', 'expiry', 'grant'])
      // Dana's year has not ended yet, whatever UTC thinks.
      expect(await minutes(dana, 2025)).toBe(9 * DAY)
      expect(await kindsOf(dana, 2026)).toEqual([])
    })

    it('converts the five-day cap at the policy day length rather than at eight hours', async () => {
      const carried = (await entries(sena, 2026)).find((e) => e.kind === 'carry_in')
      // Five days of 450 minutes is 2250. At the hardcoded 8 × 60 the cap read as 2400 — more than
      // the 2250 that could ever have been accrued on this policy, so it never bit at all.
      expect(carried?.amountMinutes).toBe(5 * DAY)
      const lapsed = (await entries(sena, 2025)).find((e) => e.kind === 'expiry')
      expect(lapsed?.amountMinutes).toBe(-4 * DAY)
      expect(lapsed?.reason).toContain('carry-forward cap')
    })

    it('says on the entry itself which day the carried leave has to be used by', async () => {
      const carried = (await entries(sena, 2026)).find((e) => e.kind === 'carry_in')
      // Three months from 1 January survives the whole of March. "Expires 1 April" is the same rule
      // and reads as a different one, so the entry carries the last usable day.
      expect(carried?.reason).toContain('use by 2026-03-31')
    })

    it('carries New York eight hours later, and does not carry Istanbul a second time', async () => {
      clockReads('2026-01-02T06:00:00Z')
      await runJob('carry-forward')

      expect(await minutes(dana, 2025)).toBe(0)
      expect(await minutes(dana, 2026)).toBe(5 * DAY)
      // Istanbul is on the 2nd at this instant too, and has nothing left to carry.
      expect((await entries(sena, 2026)).filter((e) => e.kind === 'carry_in')).toHaveLength(1)
    })
  })

  describe('the month that just ended', () => {
    it('accrues for the office whose month has turned, and only for it', async () => {
      // 01:00 on 1 February in Istanbul; 17:00 on 31 January in New York.
      clockReads('2026-01-31T22:00:00Z')
      await runJob('accrue-leave')

      const accrued = (await entries(sena, 2026)).filter((e) => e.kind === 'accrual')
      expect(accrued).toHaveLength(1)
      // A twelfth of twenty-four days of 450 minutes, stamped on the last day of the month it is for.
      expect(accrued[0]?.amountMinutes).toBe((24 * DAY) / 12)
      expect(accrued[0]?.effectiveOn).toBe('2026-01-31')
      // `date_trunc('month', now())` credited December here, to both of them at once.
      expect((await entries(dana, 2026)).filter((e) => e.kind === 'accrual')).toHaveLength(0)
      expect(await entries(sena, 2025)).not.toContainEqual(
        expect.objectContaining({ kind: 'accrual', effectiveOn: '2025-12-31' }),
      )
    })

    it('accrues New York when its own month turns, and never twice for the same period', async () => {
      clockReads('2026-02-01T06:00:00Z')
      await runJob('accrue-leave')
      await runJob('accrue-leave')

      const accrued = (await entries(dana, 2026)).filter((e) => e.kind === 'accrual')
      expect(accrued).toHaveLength(1)
      expect(accrued[0]?.effectiveOn).toBe('2026-01-31')
      expect((await entries(sena, 2026)).filter((e) => e.kind === 'accrual')).toHaveLength(1)
    })

    /**
     * `per_hour_worked`, through the job rather than through the pure function.
     *
     * The frequency was implemented in `src/policy/accrual.ts` and fed by nobody: neither the cron
     * nor `accrual.preview` passed `workedMinutes` or `scheduledMinutes`, so `grantForPeriod` took
     * its "nothing scheduled" guard, returned zero, and the job's `if (result.minutes <= 0) continue`
     * skipped every person without a word. Every test that reached the job used `monthly`, and the
     * ones that covered this frequency called the pure function and hand-fed it the two arguments
     * no caller supplied — which is how a setting comes to be accepted, saved, and ignored.
     *
     * The figures were in `attendance_days` the whole time.
     */
    it('accrues against the hours actually worked, where the policy says to', async () => {
      const WORKED = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08']

      /** Two people, one policy, the same scheduled month — differing only in what they worked. */
      const hire = async (tx: Tx, displayName: string, daysWorked: number) => {
        const [person] = await tx
          .insert(people)
          .values({ workspaceId: WS_JOBS, displayName, hiredOn: '2020-01-01', status: 'active' })
          .returning()
        await tx.insert(officeAssignments).values({
          workspaceId: WS_JOBS,
          personId: person!.id,
          officeId: istanbul,
          isPrimary: true,
          effectiveFrom: '2020-01-01',
        })
        for (const [index, day] of WORKED.entries())
          await tx.insert(attendanceDays).values({
            workspaceId: WS_JOBS,
            personId: person!.id,
            businessDate: day,
            scheduledMinutes: DAY,
            workedMinutes: index < daysWorked ? DAY : 0,
            status: index < daysWorked ? 'present' : 'absent',
          })
        const [policy] = await tx
          .insert(policies)
          .values({
            workspaceId: WS_JOBS,
            kind: 'accrual',
            name: `Earned by the hour (${displayName})`,
            config: {
              frequency: 'per_hour_worked',
              daysPerYear: 24,
              minutesPerDay: DAY,
              seniorityTiers: [],
              waitingPeriodMonths: 0,
              calendar: 'gregorian',
              roundToMinutes: 0,
              leaveTypeKey: 'annual',
            },
            effectiveFrom: '2020-01-01',
          })
          .returning()
        // On the person, so it outranks the workspace-wide monthly policy the others use.
        await tx.insert(policyAssignments).values({
          workspaceId: WS_JOBS,
          policyId: policy!.id,
          subjectKind: 'person',
          subjectId: person!.id,
          effectiveFrom: '2020-01-01',
          priority: PolicyService.priorityFor('person'),
        })
        return person!.id
      }

      const { full, half } = await run(async (tx) => ({
        full: await hire(tx, 'Worked the whole week', 4),
        half: await hire(tx, 'Worked half of it', 2),
      }))

      clockReads('2026-01-31T22:00:00Z')
      await runJob('accrue-leave')

      const credited = async (personId: string) =>
        (await entries(personId, 2026)).filter((e) => e.kind === 'accrual')

      const [fullEntry] = await credited(full)
      const [halfEntry] = await credited(half)

      // Before the job passed the hours, both of these were zero and the job skipped them silently.
      expect(fullEntry?.amountMinutes ?? 0, 'the job credited the hourly worker at all').toBeGreaterThan(0)
      expect(fullEntry?.effectiveOn).toBe('2026-01-31')

      // The property, rather than a constant: half the scheduled hours earns half the accrual,
      // whatever base the frequency prorates against. A hardcoded figure here would assert what the
      // implementation happens to do rather than what `per_hour_worked` means.
      expect(halfEntry?.amountMinutes).toBe(Math.round((fullEntry?.amountMinutes ?? 0) / 2))
    })
  })

  describe('the deadline on carried leave', () => {
    beforeAll(async () => {
      // The spender uses three of the five carried days before the deadline. Carried days are spent
      // before the new year's own accrual, so only what is left of them can lapse.
      await inJobsWs(async (tx) => {
        await svcLedger.lockAndRead(tx, WS_JOBS, spender, annual, 2026)
        await svcLedger.append(tx, WS_JOBS, {
          personId: spender,
          leaveTypeId: annual,
          kind: 'consumption',
          amountMinutes: -3 * DAY,
          effectiveOn: '2026-02-10',
          periodYear: 2026,
        })
      })
    })

    it('leaves it alone on the last day it can still be used', async () => {
      // 01:00 on 31 March in Istanbul.
      clockReads('2026-03-30T22:00:00Z')
      await runJob('carry-forward')
      expect(await kindsOf(sena, 2026)).toEqual(['accrual', 'carry_in'])
    })

    it('takes it away on the day it expires, for the office that has reached that day', async () => {
      // 01:00 on 1 April in Istanbul; 18:00 on 31 March in New York.
      clockReads('2026-03-31T22:00:00Z')
      await runJob('carry-forward')

      const lapsed = (await entries(sena, 2026)).find((e) => e.kind === 'expiry')
      expect(lapsed?.amountMinutes).toBe(-5 * DAY)
      expect(lapsed?.effectiveOn).toBe('2026-04-01')
      expect(lapsed?.reason).toContain('not used by 2026-03-31')
      // What survives is the year's own accrual, untouched.
      expect(await minutes(sena, 2026)).toBe((24 * DAY) / 12)
      // New York has not reached the 1st, so Dana still holds all five days.
      expect((await entries(dana, 2026)).some((e) => e.kind === 'expiry')).toBe(false)
    })

    it('takes only what is left of the carry, because carried days are spent first', async () => {
      const lapsed = (await entries(spender, 2026)).find((e) => e.kind === 'expiry')
      // Five carried, three spent: two lapse, not five.
      expect(lapsed?.amountMinutes).toBe(-2 * DAY)
      expect(await minutes(spender, 2026)).toBe((24 * DAY) / 12)
    })

    it('running again takes nothing more', async () => {
      await runJob('carry-forward')
      expect((await entries(sena, 2026)).filter((e) => e.kind === 'expiry')).toHaveLength(1)
      expect(await minutes(sena, 2026)).toBe((24 * DAY) / 12)
    })

    it('reaches New York eight hours later', async () => {
      clockReads('2026-04-01T06:00:00Z')
      await runJob('carry-forward')

      const lapsed = (await entries(dana, 2026)).find((e) => e.kind === 'expiry')
      expect(lapsed?.amountMinutes).toBe(-5 * DAY)
      expect(await minutes(dana, 2026)).toBe((24 * DAY) / 12)
    })
  })

  describe('a shift closed by the sweep', () => {
    beforeAll(async () => {
      await inJobsWs((tx) =>
        tx.insert(punches).values({
          workspaceId: WS_JOBS,
          personId: moved,
          direction: 'in',
          at: new Date('2026-06-29T06:00:00Z'),
          businessDate: '2026-06-29',
          timezone: IST,
        }),
      )
    })

    it('is stamped with the zone of the office that day belonged to, not the one they moved to', async () => {
      // Two days after the transfer: the ladder answers New York for today and Istanbul for the day
      // the shift was worked. Resolving "as of now" is what wrote Amsterdam onto an Istanbul night.
      clockReads('2026-07-01T12:00:00Z')
      const now = await inJobsWs((tx) => new ResolveService().forPerson(tx, WS_JOBS, moved, '2026-07-01'))
      expect(now.timezone).toBe(NY)

      await runJob('auto-clock-out')

      const rows = await inJobsWs((tx) =>
        tx
          .select()
          .from(punches)
          .where(and(eq(punches.workspaceId, WS_JOBS), eq(punches.personId, moved))),
      )
      const closed = rows.filter((r) => r.direction === 'out')
      expect(closed).toHaveLength(1)
      expect(closed[0]?.timezone).toBe(IST)
      expect(closed[0]?.note).toBe('Closed automatically: no clock-out recorded')
    })
  })

  it('leaves the offices it was given exactly as it found them', async () => {
    const rows = await inJobsWs((tx) => tx.select().from(offices).where(eq(offices.workspaceId, WS_JOBS)))
    expect(rows.map((r) => r.timezone).sort()).toEqual([NY, IST].sort())
    expect(rows.filter((r) => r.isDefault)).toHaveLength(1)
    expect([istanbul, newYork].every((id) => rows.some((r) => r.id === id))).toBe(true)
  })
})
