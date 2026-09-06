import { randomUUID } from 'node:crypto'
import type { Principal } from '@kernhq/contracts'
import { createKernel, type Kernel } from '@kernhq/kernel'
import { eq } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seedHrDemo } from './demo.js'
import { hrModule } from './index.js'
import {
  attendanceDays,
  employments,
  leaveLedger,
  leaveRequests,
  orgUnits,
  people,
  punches,
} from './schema.js'

/**
 * The demo seeder, run against a real Postgres.
 *
 * HR is the module where a seeder is most likely to look right and be wrong: a person is a row, an
 * employment is a second row, a balance is the sum of a third table, and an attendance day is
 * derived from punches. Only a database can say whether all four agree.
 */

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB_NAME = `kern_hr_demo_${Date.now().toString(36)}`

let kernel: Kernel
let admin: pg.Client

const WS = randomUUID()
const OWNER = randomUUID()

const actor = (): Principal =>
  ({
    kind: 'service',
    userId: OWNER,
    email: null,
    name: 'service:test',
    locale: 'en',
    instanceAdmin: true,
    service: 'test',
    memberships: [],
    permissionVersion: 0,
  }) as unknown as Principal

const seed = () => seedHrDemo({ kernel, workspaceId: WS, actorId: OWNER, actor: actor(), now: new Date() })

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`create database "${DB_NAME}"`)
  const url = new URL(BASE_URL)
  url.pathname = `/${DB_NAME}`

  kernel = await createKernel({
    service: 'hr-demo-test',
    modules: [hrModule],
    role: 'api',
    env: {
      DATABASE_URL: url.toString(),
      KERN_SECRET: 'test-secret-that-is-long-enough-for-kern',
      NODE_ENV: 'test',
      NATS_URL: undefined,
      VALKEY_URL: undefined,
    },
  })
  kernel.broker.register('core', {
    'activity.record': { handler: async () => ({ ok: true }) },
    'notifications.create': { handler: async () => ({ ok: true }) },
    'search.index': { handler: async () => ({ ok: true }) },
    'search.remove': { handler: async () => ({ ok: true }) },
    'settings.getModule': { handler: async () => ({}) },
    'modules.isEnabled': { handler: async () => true },
    'authz.customRolePermissions': { handler: async () => [] },
    'authz.bindings': { handler: async () => [] },
    'workspaces.members': { handler: async () => [] },
  })
  await kernel.start()
  // The office and the holiday calendar the seeder hangs everything off.
  await hrModule.onWorkspaceEnabled?.(WS, kernel)
}, 180_000)

afterAll(async () => {
  await kernel?.stop().catch(() => undefined)
  await admin.query(`drop database if exists "${DB_NAME}" with (force)`).catch(() => undefined)
  await admin.end().catch(() => undefined)
})

describe('the demo seeder', () => {
  it('staffs an empty workspace', async () => {
    const summary = await seed()
    expect(summary.skipped).toBeFalsy()

    const rows = await kernel.database.withWorkspace(WS, async (tx) => ({
      people: await tx.select().from(people).where(eq(people.workspaceId, WS)),
      units: await tx.select().from(orgUnits).where(eq(orgUnits.workspaceId, WS)),
      employments: await tx.select().from(employments).where(eq(employments.workspaceId, WS)),
      ledger: await tx.select().from(leaveLedger).where(eq(leaveLedger.workspaceId, WS)),
      leave: await tx.select().from(leaveRequests).where(eq(leaveRequests.workspaceId, WS)),
      punches: await tx.select().from(punches).where(eq(punches.workspaceId, WS)),
      days: await tx.select().from(attendanceDays).where(eq(attendanceDays.workspaceId, WS)),
    }))

    // Twelve colleagues plus the person who asked for the demo.
    expect(rows.people.length).toBe(13)
    expect(rows.units.length).toBe(5)
    // Everybody has an employment, which is what puts them in a department on the org chart.
    expect(rows.employments.length).toBe(rows.people.length)
    expect(rows.employments.filter((e) => e.managerPersonId).length).toBeGreaterThan(5)
    // Every department has a head, and each head is one of the people.
    const personIds = new Set(rows.people.map((p) => p.id))
    expect(rows.units.every((u) => u.headPersonId && personIds.has(u.headPersonId))).toBe(true)

    // A balance is the sum of the ledger: one accrual each, plus a consumption per approved request.
    const approved = rows.leave.filter((l) => l.status === 'approved')
    expect(rows.leave.length).toBe(7)
    expect(approved.length).toBe(4)
    expect(rows.ledger.filter((e) => e.kind === 'accrual').length).toBe(13)
    expect(rows.ledger.filter((e) => e.kind === 'consumption').length).toBe(approved.length)
    // Pending leave holds no balance — that is the whole reason a request and a ledger entry are
    // different things.
    const spentFor = new Set(rows.ledger.filter((e) => e.requestId).map((e) => e.requestId))
    expect(rows.leave.filter((l) => l.status === 'pending').every((l) => !spentFor.has(l.id))).toBe(true)

    // Three people clocked in and out across five weekdays, and each day was recomputed.
    expect(rows.punches.length).toBe(30)
    expect(rows.days.length).toBe(15)
    expect(rows.days.every((d) => (d.workedMinutes ?? 0) > 0)).toBe(true)
  })

  it('leaves a workspace that already holds something alone', async () => {
    const before = await kernel.database.withWorkspace(WS, (tx) =>
      tx.select().from(people).where(eq(people.workspaceId, WS)),
    )
    expect((await seed()).skipped).toBe(true)
    const after = await kernel.database.withWorkspace(WS, (tx) =>
      tx.select().from(people).where(eq(people.workspaceId, WS)),
    )
    expect(after.length).toBe(before.length)
  })
})
