import type { PermissionScope, Principal } from '@kernhq/contracts'
import type { Kernel } from '@kernhq/kernel'
import { describe, expect, it } from 'vitest'
import { HR_PERMISSIONS } from '../../contract/index.js'
import { forViewer, HrAccessService, seesRecordOf, visibleSet } from './access.js'

/**
 * The half of the record scope that needs no database.
 *
 * What is covered here is the part that was wrong before and is easy to get wrong again: *which
 * question is asked of `Authz`*. The `.use(requires('hr.person.view_team'))` that this replaces
 * looked correct and scoped nothing, because `Authz.can` falls through to the workspace-level
 * effective set whenever there is no object-scope binding for the id it was handed — so an
 * object-scoped check passes for anybody holding the key at workspace level. The tests below pin
 * the shape that avoids it: `view_all` decided by `can`, the two narrower keys read out of the
 * workspace set, and a holder of a narrow key never answered "unbounded".
 *
 * What is **not** covered here is the resolution itself — which people are in the subtree you head,
 * which are assigned to your office. That is three joins, an ltree containment operator and two
 * effective-dated tables, and a fake `tx` that returned rows for it would be testing the fake. It
 * belongs beside the other things only Postgres can answer, in `hr.int.test.ts`.
 */

/** A member of one workspace. Branded ids on `Principal` are a difference these tests do not model. */
const principal = (userId = 'u1'): Principal =>
  ({
    kind: 'user',
    userId,
    email: `${userId}@example.test`,
    name: userId,
    locale: 'en',
    instanceAdmin: false,
    service: null,
    memberships: [{ workspaceId: 'ws1', role: 'member', roleIds: [], groupIds: [], status: 'active' }],
    permissionVersion: 0,
  }) as unknown as Principal

/** What `Authz` was asked, so a test can assert the *scope* and not only the answer. */
type Asked = { permission: string; scope: PermissionScope & { workspaceId: string } }

function kernelHolding(keys: string[]) {
  const asked: Asked[] = []
  const held = new Set(keys)
  const kernel = {
    authz: {
      can: async (_p: Principal, permission: string, scope: Asked['scope']) => {
        asked.push({ permission, scope })
        return held.has(permission)
      },
      effective: async () => held,
    },
  } as unknown as Kernel
  return { kernel, asked }
}

describe('which widening keys a viewer holds', () => {
  it('asks for view_all at workspace scope, never at object scope', async () => {
    // The trap, pinned. An object-scoped question here would be answered from the workspace set
    // anyway and would read as if it had scoped something.
    const { kernel, asked } = kernelHolding([])
    await new HrAccessService(kernel).grantsFor(principal(), 'ws1')
    expect(asked[0]?.permission).toBe(HR_PERMISSIONS.personViewAll)
    expect(asked[0]?.scope.kind).toBe('workspace')
    expect(asked[0]?.scope.workspaceId).toBe('ws1')
  })

  it('stops at view_all, because it already implies the other two', async () => {
    const { kernel, asked } = kernelHolding([HR_PERMISSIONS.personViewAll])
    const grants = await new HrAccessService(kernel).grantsFor(principal(), 'ws1')
    expect(grants).toEqual({ all: true, team: true, office: true })
    expect(asked).toHaveLength(1)
  })

  it('reads the two narrower keys without letting either imply the other', async () => {
    const { kernel } = kernelHolding([HR_PERMISSIONS.personViewOffice])
    const grants = await new HrAccessService(kernel).grantsFor(principal(), 'ws1')
    expect(grants).toEqual({ all: false, team: false, office: true })
  })

  it('gives a plain member none of them', async () => {
    const { kernel } = kernelHolding([HR_PERMISSIONS.personView])
    const grants = await new HrAccessService(kernel).grantsFor(principal(), 'ws1')
    expect(grants).toEqual({ all: false, team: false, office: false })
  })

  it('lets a writer read what it can write', async () => {
    // `PersonPanel` fills its form from the record it is about to save back, so a manager holding
    // a redacted card would blank the personal email and phone of everybody they edited — silent
    // data loss on an ordinary save. `manage` is workspace-wide and has no narrow variant, so
    // reading everything it may already overwrite takes nothing away from anybody.
    const { kernel } = kernelHolding([HR_PERMISSIONS.personView, HR_PERMISSIONS.personManage])
    const grants = await new HrAccessService(kernel).grantsFor(principal(), 'ws1')
    expect(grants).toEqual({ all: true, team: true, office: true })
  })
})

describe('the set of people a viewer reads in full', () => {
  it('is unbounded only for view_all, and costs no query to say so', async () => {
    const { kernel } = kernelHolding([HR_PERMISSIONS.personViewAll])
    // `null` before anything touches the transaction: a workspace of five thousand must not build a
    // five-thousand-element set on every directory page. `tx` would throw if it were used.
    const ids = await new HrAccessService(kernel).visiblePersonIds(null as never, 'ws1', principal())
    expect(ids).toBeNull()
  })

  it('is bounded for a team head, however wide their team turns out to be', async () => {
    // The whole point of the fix: holding a narrow key at workspace level must not answer
    // "everybody", which is what an object-scoped `requires` would have done.
    const { kernel } = kernelHolding([HR_PERMISSIONS.personView, HR_PERMISSIONS.personViewTeam])
    const grants = await new HrAccessService(kernel).grantsFor(principal(), 'ws1')
    expect(grants.all).toBe(false)
  })
})

describe('a person as a viewer may read them', () => {
  const person = {
    id: 'p1',
    displayName: 'Ayşe Yılmaz',
    employeeNo: 'K-104',
    workEmail: 'ayse@example.test',
    personalEmail: 'ayse@personal.test',
    phone: '+90 555 000 00 00',
    hiredOn: '2021-03-01',
    terminatedOn: null,
    custom: { desk: '4-12' },
    personnelHidden: false,
  }

  it('hands back the whole record, unchanged, when nothing is hidden', () => {
    expect(forViewer(person, null)).toBe(person)
    expect(forViewer(person, visibleSet(['p1']))).toBe(person)
  })

  it('nulls the four personnel fields and keeps the card', () => {
    const card = forViewer(person, visibleSet(['p2']))
    expect(card).toEqual({
      ...person,
      personalEmail: null,
      phone: null,
      hiredOn: null,
      terminatedOn: null,
      personnelHidden: true,
    })
    // A directory that cannot tell you somebody's name or work email is not a directory.
    expect(card.displayName).toBe('Ayşe Yılmaz')
    expect(card.workEmail).toBe('ayse@example.test')
    expect(card.employeeNo).toBe('K-104')
  })

  /**
   * The flag is the whole reason a screen can say "Hidden" instead of drawing a blank, and the two
   * are different facts: an empty phone field reads as "this person has no phone number". A record
   * that was never narrowed must therefore never carry it, or every genuinely empty field in the
   * company starts claiming it was withheld.
   */
  it('marks a narrowed record and leaves an unnarrowed one unmarked', () => {
    expect(forViewer(person, visibleSet(['p2'])).personnelHidden).toBe(true)
    expect(forViewer(person, visibleSet(['p1'])).personnelHidden).toBe(false)
    expect(forViewer(person, null).personnelHidden).toBe(false)
  })

  it('does not mark a person whose personnel fields are simply empty', () => {
    const sparse = { ...person, personalEmail: null, phone: null, hiredOn: null, terminatedOn: null }
    // Every field null and still visible: nothing was withheld, so nothing claims it was.
    expect(forViewer(sparse, null).personnelHidden).toBe(false)
  })

  it('does not mutate the row it narrowed', () => {
    forViewer(person, visibleSet([]))
    expect(person.phone).toBe('+90 555 000 00 00')
  })

  it('lets everybody read their own record, with no key at all', () => {
    // `visiblePersonIds` always seeds the set with the viewer, so this is the shape it produces for
    // somebody holding `hr.person.view` and nothing else.
    const own = visibleSet(['p1'])
    expect(seesRecordOf(own, 'p1')).toBe(true)
    expect(seesRecordOf(own, 'p2')).toBe(false)
  })

  it('treats an empty scope as nobody, never as everybody', () => {
    // `inArray(col, [])` in drizzle and `[]` here fail the same way when read as "no filter", and
    // that mistake is silent: it reads as a working directory that shows too much.
    expect(seesRecordOf(visibleSet([]), 'p1')).toBe(false)
    expect(seesRecordOf(null, 'p1')).toBe(true)
  })
})
