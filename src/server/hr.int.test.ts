import { randomUUID } from 'node:crypto'
import type { Principal } from '@kernhq/contracts'
import { createKernel, type Kernel, type Tx } from '@kernhq/kernel'
import { and, eq } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hrModule } from './index.js'
import {
  calendarDays,
  calendars,
  employments,
  officeAssignments,
  offices,
  people,
  TENANT_TABLES,
} from './schema.js'
import { PeopleService } from './services/people.js'
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
  }) as Principal

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

  it('secures every table the schema declares, with none forgotten', () => {
    // Guards the other direction: a table added to schema.ts but left out of TENANT_TABLES would
    // pass the test above by simply never being asked about.
    const declared = new Set<string>(TENANT_TABLES)
    for (const t of ['people', 'offices', 'employments', 'office_assignments', 'calendars'])
      expect(declared.has(t), `${t} is in TENANT_TABLES`).toBe(true)
    expect(declared.size).toBe(14)
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
