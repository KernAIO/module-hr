/**
 * The HR permission matrix, blessed rather than assumed.
 *
 * Forty-one keys declared one at a time make the whole picture — which built-in role ends up holding
 * what — impossible to read from any single line, and HR is the module where that picture matters
 * most: it decides who sees a colleague's home address. This writes the matrix out in full and
 * compares it against what the module declares. Rows list the *effective* grants, cascade included:
 * the kernel expands declared `defaultRoles` upward through guest ⊆ member ⊆ admin ⊆ owner, and
 * `permissionMatrixDiff` applies the same expansion. An empty row is a permission nobody holds by
 * default — every sensitive and privacy key is one, on purpose.
 *
 * Changing a default is meant to be deliberate: edit `defaultRoles` → this fails naming every row
 * that moved → confirm that is what you meant → update `BLESSED` in the same commit.
 */
import { permissionMatrixDiff } from '@kernhq/testing'
import { describe, expect, it } from 'vitest'
import { hrPermissions } from './permissions.js'

/** Every built-in role that holds the permission by default, lowest role first. */
const BLESSED: Record<string, readonly string[]> = {
  // people — the widening ladder: everybody gets the card, the file widens by key
  'hr.person.view': ['member', 'admin', 'owner'],
  'hr.person.view_team': ['admin', 'owner'],
  'hr.person.view_office': ['admin', 'owner'],
  'hr.person.view_all': ['admin', 'owner'],
  'hr.person.manage': ['admin', 'owner'],
  'hr.person.view_sensitive': [],
  'hr.person.manage_sensitive': [],
  'hr.employment.view': ['admin', 'owner'],
  'hr.employment.manage': ['admin', 'owner'],

  // organisation
  'hr.org.view': ['member', 'admin', 'owner'],
  'hr.org.manage': ['admin', 'owner'],
  'hr.office.view': ['member', 'admin', 'owner'],
  'hr.office.manage': ['admin', 'owner'],
  'hr.office.assign': ['admin', 'owner'],
  'hr.entity.view': ['admin', 'owner'],
  'hr.entity.manage': ['owner'],
  'hr.calendar.view': ['guest', 'member', 'admin', 'owner'],
  'hr.calendar.manage': ['admin', 'owner'],
  'hr.document.view': [],
  'hr.document.manage': [],

  // leave
  'hr.leave.request': ['member', 'admin', 'owner'],
  'hr.leave.view': ['member', 'admin', 'owner'],
  'hr.leave.view_team': ['admin', 'owner'],
  'hr.leave.view_ledger': ['admin', 'owner'],
  'hr.leave.manage': ['admin', 'owner'],
  'hr.leave.adjust': [],

  // attendance
  'hr.attendance.punch': ['member', 'admin', 'owner'],
  'hr.attendance.view': ['member', 'admin', 'owner'],
  'hr.attendance.view_team': ['admin', 'owner'],
  'hr.attendance.manage': ['admin', 'owner'],

  // reports, payroll, policy
  'hr.report.view': ['admin', 'owner'],
  'hr.payroll.export': [],
  'hr.policy.view': ['admin', 'owner'],
  'hr.policy.manage': ['owner'],
  'hr.period.manage': ['owner'],

  // approvals, privacy, fields, checklists
  'hr.approval.manage': ['admin', 'owner'],
  'hr.approval.delegate': ['member', 'admin', 'owner'],
  'hr.privacy.manage': [],
  'hr.field.manage': ['admin', 'owner'],
  'hr.checklist.view': ['member', 'admin', 'owner'],
  'hr.checklist.manage': ['admin', 'owner'],
}

/** Permissions whose misuse reaches a person's file, their pay, or the record a wage was computed from. */
const DANGEROUS = [
  'hr.person.view_sensitive',
  'hr.person.manage_sensitive',
  'hr.employment.manage',
  'hr.document.view',
  'hr.document.manage',
  'hr.leave.adjust',
  'hr.attendance.manage',
  'hr.payroll.export',
  'hr.policy.manage',
  'hr.period.manage',
  'hr.privacy.manage',
]

describe('hr permissions', () => {
  it('grants each permission to exactly the blessed roles', () => {
    expect(permissionMatrixDiff(hrPermissions, BLESSED)).toEqual([])
  })

  it('namespaces every key under the module id and declares it once', () => {
    const keys = hrPermissions.map((p) => p.key)
    expect(keys.filter((key) => !key.startsWith('hr.'))).toEqual([])
    expect(keys.filter((key, i) => keys.indexOf(key) !== i)).toEqual([])
  })

  it('marks exactly the destructive permissions dangerous', () => {
    const flagged = hrPermissions.filter((p) => p.dangerous).map((p) => p.key)
    expect(flagged.toSorted()).toEqual(DANGEROUS.toSorted())
  })

  it('hands nobody a sensitive or privacy key by default', () => {
    // The point of the ladder: a workspace grants these to a named person, and every read under
    // them is logged. A default here would be a default nobody chose.
    const nobody = Object.entries(BLESSED)
      .filter(([, roles]) => roles.length === 0)
      .map(([key]) => key)
    expect(nobody.toSorted()).toEqual(
      [
        'hr.person.view_sensitive',
        'hr.person.manage_sensitive',
        'hr.document.view',
        'hr.document.manage',
        'hr.leave.adjust',
        'hr.payroll.export',
        'hr.privacy.manage',
      ].toSorted(),
    )
  })
})
