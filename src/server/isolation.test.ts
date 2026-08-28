import { randomUUID } from 'node:crypto'
import type { Principal } from '@kernhq/contracts'
import { CAPABILITIES_KEY, createKernel, type Kernel, type RequestContext, type Tx } from '@kernhq/kernel'
import { call } from '@orpc/server'
import { and, eq } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hrModule } from './index.js'
import { implement_ } from './router.js'
import { calendars, people } from './schema.js'

/**
 * Cross-tenant isolation, as a class rather than as a list of bugs.
 *
 * Every case hands HR an id that belongs to **workspace A** while the work is scoped to
 * **workspace B**. A query whose `WHERE` is only `eq(table.id, input.something)` finds that row and
 * acts on it — which is how `person.get` answered with a stranger's employee, and how a member
 * leaving one workspace unlinked that account's HR record in every other one.
 *
 * Two layers are asserted, because neither substitutes for the other:
 *
 *  1. **the service**, which must answer HR's honest *not found* — never `forbidden`, which would
 *     confirm the row exists — or decline to touch the foreign row;
 *  2. **row-level security**, which is only observable under a role that cannot bypass it. The
 *     development user is a superuser and superusers bypass RLS entirely, so the probe below opens
 *     a connection as an explicit `nosuperuser nobypassrls` role. Without that these assertions
 *     would pass just as happily against tables carrying no policy at all.
 */

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB_NAME = `kern_hr_iso_${Date.now().toString(36)}`
const RLS_ROLE = `kern_hr_iso_rls_${Date.now().toString(36)}`

let kernel: Kernel
let hr: ReturnType<typeof implement_>
let admin: pg.Client
let databaseUrl: string

const WS_A = randomUUID()
const WS_B = randomUUID()
const ALICE = randomUUID()
/** Holds an account *and* a person record in both workspaces — the case the sweep got wrong. */
const DUAL_USER = randomUUID()

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
  }) as unknown as Principal

const inWs =
  (workspaceId: string) =>
  <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    kernel.database.withWorkspace(workspaceId, fn, { userId: ALICE })

const runA = inWs(WS_A)
const runB = inWs(WS_B)

const asUser = (userId: string, workspaceId: string): RequestContext => ({
  kernel,
  principal: principal(userId, workspaceId),
  requestId: randomUUID(),
  ip: '127.0.0.1',
  headers: {},
})

function registerCoreStubs(k: Kernel) {
  k.broker.register('core', {
    'activity.record': { handler: async () => ({ ok: true }) },
    'notifications.create': { handler: async () => ({ ok: true }) },
    'search.index': { handler: async () => ({ ok: true }) },
    'modules.isEnabled': { handler: async () => true },
    'users.principal': { handler: async (i: { userId: string }) => principal(i.userId, WS_A) },
    'authz.customRolePermissions': { handler: async () => [] },
    'authz.bindings': { handler: async () => [] },
    'settings.getModule': { handler: async () => ({ [CAPABILITIES_KEY]: { attendance: true } }) },
    'settings.setModule': { handler: async () => ({ ok: true }) },
  })
}

/** Seeded in A — the ids a caller standing in B tries to reach. */
const personA = randomUUID()
const dualPersonA = randomUUID()
const calendarA = randomUUID()
/** Seeded in B, so the cross-tenant calls have somewhere legitimate to stand. */
const dualPersonB = randomUUID()

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`create database "${DB_NAME}"`)
  const url = new URL(BASE_URL)
  url.pathname = `/${DB_NAME}`
  databaseUrl = url.toString()

  kernel = await createKernel({
    service: 'hr-isolation-test',
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

  await runA((tx) =>
    tx.insert(people).values([
      { id: personA, workspaceId: WS_A, displayName: 'Alpha Employee', userId: ALICE },
      { id: dualPersonA, workspaceId: WS_A, displayName: 'Contractor in A', userId: DUAL_USER },
    ]),
  )
  await runA((tx) =>
    tx.insert(calendars).values({ id: calendarA, workspaceId: WS_A, name: 'Alpha calendar' }),
  )
  await runB((tx) =>
    tx
      .insert(people)
      .values({ id: dualPersonB, workspaceId: WS_B, displayName: 'Contractor in B', userId: DUAL_USER }),
  )
}, 180_000)

afterAll(async () => {
  await kernel?.stop().catch(() => undefined)
  await admin?.query(`drop database if exists "${DB_NAME}" with (force)`).catch(() => undefined)
  await admin?.query(`drop role if exists "${RLS_ROLE}"`).catch(() => undefined)
  await admin?.end().catch(() => undefined)
}, 60_000)

describe('an id from workspace A, used from workspace B', () => {
  it('does not resolve a person by id for the wrong workspace', async () => {
    const own = await kernel.call<{ id: string } | null>('hr.person.get', {
      workspaceId: WS_A,
      personId: personA,
    })
    expect(own?.id).toBe(personA)

    const across = await kernel.call<{ id: string } | null>('hr.person.get', {
      workspaceId: WS_B,
      personId: personA,
    })
    expect(across, "B was handed A's employee record").toBeNull()
  })

  it('does not resolve a person by account for the wrong workspace', async () => {
    // `people.user_id` is not unique across workspaces — the same account legitimately holds a
    // record in several. Without the workspace predicate this answered with whichever row Postgres
    // returned first, so it was both a leak and a coin toss.
    const own = await kernel.call<{ id: string } | null>('hr.person.byUserId', {
      workspaceId: WS_B,
      userId: DUAL_USER,
    })
    expect(own?.id).toBe(dualPersonB)

    const across = await kernel.call<{ id: string } | null>('hr.person.byUserId', {
      workspaceId: WS_B,
      userId: ALICE,
    })
    expect(across, "B was handed A's employee record").toBeNull()
  })

  it('does not unlink an account in one workspace when it is removed from another', async () => {
    // `core.member.removed` cleared `people.user_id` wherever it matched, so leaving workspace B
    // silently detached the same person's record in A — an employment file losing its account for
    // a reason that had nothing to do with it.
    const removed = hrModule.subscriptions?.['core.member.removed']
    expect(removed, 'the subscription this test is about').toBeTruthy()
    await removed!({ payload: { workspaceId: WS_B, userId: DUAL_USER } } as never, kernel)

    const [inB] = await runB((tx) =>
      tx
        .select()
        .from(people)
        .where(and(eq(people.workspaceId, WS_B), eq(people.id, dualPersonB))),
    )
    expect(inB?.userId, 'the workspace they actually left kept the link').toBeNull()

    const [inA] = await runA((tx) =>
      tx
        .select()
        .from(people)
        .where(and(eq(people.workspaceId, WS_A), eq(people.id, dualPersonA))),
    )
    expect(inA?.userId, "leaving B unlinked the same person's record in A").toBe(DUAL_USER)
  })

  it("refuses to stamp a holiday pack onto another workspace's calendar", async () => {
    // `diffPack` never proved the calendar was the caller's, so `apply` reported an empty diff to B
    // while writing `pack_key` and `pack_version` onto a calendar that belongs to A.
    await expect(
      call(
        hr.calendars.pack.apply,
        { workspaceId: WS_B, calendarId: calendarA, packKey: 'TR', year: 2026 },
        { context: asUser(ALICE, WS_B) },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const [row] = await runA((tx) =>
      tx
        .select()
        .from(calendars)
        .where(and(eq(calendars.workspaceId, WS_A), eq(calendars.id, calendarA))),
    )
    expect(row?.packKey, "B stamped a holiday pack onto A's calendar").toBeNull()
  })
})

/**
 * The same question asked of Postgres rather than of the service layer.
 *
 * `nosuperuser nobypassrls` is the whole point: the pool in a default deployment connects as the
 * superuser, which bypasses every policy, so this is the only role that can tell a working policy
 * from a missing one.
 */
describe('row-level security, under a role that cannot bypass it', () => {
  let plain: pg.Client

  beforeAll(async () => {
    const scratch = new pg.Client({ connectionString: databaseUrl })
    await scratch.connect()
    await scratch.query(`create role "${RLS_ROLE}" login password 'probe' nosuperuser nobypassrls`)
    await scratch.query(`grant usage on schema mod_hr to "${RLS_ROLE}"`)
    await scratch.query(
      `grant select, insert, update, delete on all tables in schema mod_hr to "${RLS_ROLE}"`,
    )
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

  /**
   * `false` is load-bearing: the third argument is `is_local`, and a *local* setting lasts only for
   * the current transaction — which, for an implicit single-statement one, is already over by the
   * next query. Set it locally and every assertion below passes vacuously, against a session that
   * has no workspace at all and can therefore see nothing.
   */
  const scopeTo = (workspaceId: string) =>
    plain.query(`select set_config('app.workspace_id', $1, false)`, [workspaceId])

  it("hides A's rows from a session scoped to B", async () => {
    await scopeTo(WS_B)
    const seen = await plain.query<{ n: number }>(
      `select count(*)::int as n from mod_hr.people where id = $1`,
      [personA],
    )
    expect(seen.rows[0]?.n).toBe(0)
    const cal = await plain.query<{ n: number }>(
      `select count(*)::int as n from mod_hr.calendars where id = $1`,
      [calendarA],
    )
    expect(cal.rows[0]?.n).toBe(0)
  })

  it("refuses to mutate A's rows from a session scoped to B", async () => {
    await scopeTo(WS_B)
    const updated = await plain.query(`update mod_hr.people set display_name = 'seized' where id = $1`, [
      personA,
    ])
    expect(updated.rowCount, "B's UPDATE reached a row in A").toBe(0)
  })

  it('still shows each workspace its own rows, so the probe is not vacuous', async () => {
    await scopeTo(WS_A)
    const seen = await plain.query<{ n: number }>(
      `select count(*)::int as n from mod_hr.people where id = $1`,
      [personA],
    )
    expect(seen.rows[0]?.n).toBe(1)
  })
})
