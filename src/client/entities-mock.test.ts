import { describe, expect, it } from 'vitest'
import { createMockHrApi } from './mock.js'

/**
 * The legal-entity and cost-centre half of the in-memory API.
 *
 * The settings screen is developed and demonstrated against `dev:mock`, and `shell`'s end-to-end
 * suite runs the whole of it there — so for this area the mock *is* the backend, and nothing else
 * checks it: `getHrApi` casts it through `unknown`, which is what lets it be partial and is also
 * what stops the compiler noticing a procedure that answers the wrong shape.
 *
 * What is worth asserting is not that a create returns an object but that the *state* moves the way
 * the real router moves it, because that is what a screen is read against: an archive that left the
 * default list would make the archived toggle look broken, and a list in insertion order would put
 * a new employer somewhere the server never does.
 *
 * Only this area. The rest of `mock.ts` predates the file and is left to the screens that use it.
 */
const ws = '01920000-0000-7000-8000-000000000001'

describe('entities in the mock', () => {
  it('lists the seeded employers by name, archived ones only when asked', async () => {
    const api = createMockHrApi()
    const live = await api.entities.list({ workspaceId: ws })
    expect(live.map((e) => e.name)).toEqual(['Kern Europe B.V.', 'Kern Teknoloji A.Ş.'])
    // Every row carries the tenant back, because the contract's model has it and a screen reads it.
    for (const entity of live) expect(entity.workspaceId).toBe(ws)
    expect(await api.entities.list({ workspaceId: ws, includeArchived: true })).toHaveLength(2)
  })

  it('creates an employer that appears in the next list, in name order', async () => {
    const api = createMockHrApi()
    const created = await api.entities.create({
      workspaceId: ws,
      name: 'Aardvark GmbH',
      country: 'DE',
      currency: 'EUR',
    })
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.archivedAt).toBeNull()
    // Nothing was passed for these two, and the contract says they are nullable rather than absent.
    expect(created.registrationNo).toBeNull()
    expect(created.taxNo).toBeNull()
    const names = (await api.entities.list({ workspaceId: ws })).map((e) => e.name)
    expect(names[0]).toBe('Aardvark GmbH')
  })

  it('patches only what it was handed, and clears a field given an explicit null', async () => {
    const api = createMockHrApi()
    const [first] = await api.entities.list({ workspaceId: ws })
    const updated = await api.entities.update({
      workspaceId: ws,
      entityId: first!.id,
      name: 'Kern Europe Holding B.V.',
      registrationNo: null,
    })
    expect(updated.name).toBe('Kern Europe Holding B.V.')
    expect(updated.registrationNo).toBeNull()
    // Untouched, because `update` was not handed it — the trap a truthiness check would produce.
    expect(updated.taxNo).toBe(first!.taxNo)
    expect(await api.entities.get({ workspaceId: ws, entityId: first!.id })).toEqual(updated)
  })

  it('archives rather than deletes, and keeps the row behind the toggle', async () => {
    const api = createMockHrApi()
    const [first] = await api.entities.list({ workspaceId: ws })
    expect(await api.entities.archive({ workspaceId: ws, entityId: first!.id })).toEqual({ ok: true })
    expect((await api.entities.list({ workspaceId: ws })).map((e) => e.id)).not.toContain(first!.id)
    const all = await api.entities.list({ workspaceId: ws, includeArchived: true })
    expect(all.find((e) => e.id === first!.id)?.archivedAt).toEqual(expect.any(String))
  })

  it('refuses an id it does not hold, with the code the router would send', async () => {
    const api = createMockHrApi()
    const missing = '01920000-0000-7000-8000-0000000000ff'
    for (const call of [
      () => api.entities.get({ workspaceId: ws, entityId: missing }),
      () => api.entities.update({ workspaceId: ws, entityId: missing, name: 'x' }),
      () => api.entities.archive({ workspaceId: ws, entityId: missing }),
    ])
      await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('cost centres in the mock', () => {
  it('lists the seeded centres by code, with all three attachments represented', async () => {
    const api = createMockHrApi()
    const centres = await api.entities.costCenters.list({ workspaceId: ws })
    expect(centres.map((c) => c.code)).toEqual(['CC-AMS', 'CC-ENG', 'CC-PC'])
    // One with an office and no department, one with a department and no office: a demo where every
    // row named all three would hide that all three are optional.
    expect(centres.find((c) => c.code === 'CC-AMS')?.orgUnitId).toBeNull()
    expect(centres.find((c) => c.code === 'CC-PC')?.officeId).toBeNull()
    for (const centre of centres) expect(centre.legalEntityId).toEqual(expect.any(String))
  })

  it('creates one attached to nothing, which is a workspace-wide cost centre', async () => {
    const api = createMockHrApi()
    const created = await api.entities.costCenters.create({
      workspaceId: ws,
      code: 'CC-ALL',
      name: 'Shared',
    })
    expect(created).toMatchObject({
      workspaceId: ws,
      code: 'CC-ALL',
      officeId: null,
      orgUnitId: null,
      legalEntityId: null,
      archivedAt: null,
    })
    expect((await api.entities.costCenters.list({ workspaceId: ws })).map((c) => c.code)).toContain('CC-ALL')
  })

  it('archives rather than deletes, and refuses an id it does not hold', async () => {
    const api = createMockHrApi()
    const [first] = await api.entities.costCenters.list({ workspaceId: ws })
    await api.entities.costCenters.archive({ workspaceId: ws, costCenterId: first!.id })
    expect((await api.entities.costCenters.list({ workspaceId: ws })).map((c) => c.id)).not.toContain(
      first!.id,
    )
    const all = await api.entities.costCenters.list({ workspaceId: ws, includeArchived: true })
    expect(all.find((c) => c.id === first!.id)?.archivedAt).toEqual(expect.any(String))
    await expect(
      api.entities.costCenters.archive({
        workspaceId: ws,
        costCenterId: '01920000-0000-7000-8000-0000000000ff',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  /**
   * `hr_cost_centers_ws_code_uq` is on (workspace, code) and does not exclude archived rows, so
   * archiving a centre does not free its code. A mock that accepted the duplicate would let the
   * create dialog look like it worked against a server that refuses it.
   */
  it('refuses a code already in use, archived rows included', async () => {
    const api = createMockHrApi()
    await expect(
      api.entities.costCenters.create({ workspaceId: ws, code: 'CC-ENG', name: 'Engineering again' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    const [first] = await api.entities.costCenters.list({ workspaceId: ws })
    await api.entities.costCenters.archive({ workspaceId: ws, costCenterId: first!.id })
    await expect(
      api.entities.costCenters.create({ workspaceId: ws, code: first!.code, name: 'Reused' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('gives each mock its own state, so one test cannot see another’s writes', async () => {
    const first = createMockHrApi()
    await first.entities.costCenters.create({ workspaceId: ws, code: 'CC-X', name: 'X' })
    const second = createMockHrApi()
    expect((await second.entities.costCenters.list({ workspaceId: ws })).map((c) => c.code)).not.toContain(
      'CC-X',
    )
  })
})
