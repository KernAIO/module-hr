import type { Kernel } from '@kernhq/kernel'
import { describe, expect, it } from 'vitest'
import {
  HrRetention,
  hrCapabilityProcedures,
  hrContract,
  hrPermissions,
  RetentionClass,
} from '../../contract/index.js'
import { implement_ } from '../router.js'
import {
  closingBalance,
  EMPTY_RETENTION,
  erasureDisplayName,
  isRedactableHistoryField,
  REDACTED_HISTORY_FIELDS,
  RETENTION_CLASSES,
  retentionCutoff,
  SECTION_CAPS,
  scrubNames,
  stripSensitiveCustom,
} from './privacy.js'

/**
 * The redaction rules, without a database.
 *
 * Every judgement this feature makes about *what counts as identifying* is a pure function in
 * `privacy.ts`, deliberately, so it can be pinned here rather than only inside an integration run
 * that needs Postgres. What is left for `hr.int.test.ts` is the part that genuinely needs a
 * database: that the predicates match the rows they claim to, and that a second erasure is a no-op.
 *
 * The last block is a different kind of check and belongs here for the same reason `module.test.ts`
 * exists — it walks the contract and the router as data and asserts the properties that compile
 * perfectly while being wrong.
 */

describe('the pseudonym an erased person is shown under', () => {
  it('uses the employee number when there is one', () => {
    expect(erasureDisplayName({ id: '0193f2a1-0000-7000-8000-000000000000', employeeNo: 'E-0042' })).toBe(
      'E-0042',
    )
  })

  /**
   * The trade-off this pins, stated rather than implied.
   *
   * The employee number **survives erasure** — it is the payroll join key, a payslip already carries
   * it, and the design keeps it on purpose. So an erased person is not un-identifiable to anybody
   * holding that number and a copy of the payroll: erasure removes the name, the emails, the phone,
   * the photo, the bank details and the identity number, and it does not break that one link.
   *
   * Promoting it into `display_name` discloses nothing further, because `Person.employeeNo` is
   * already returned to every holder of `hr.person.view` and `forViewer` does not narrow it. The
   * honest summary is that erasure makes somebody anonymous to a *reader*, not to a *payroll
   * system*, and that is a property of retaining `employee_no` rather than of this function.
   */
  it('leaves the payroll join key intact, which is a link erasure does not break', () => {
    const name = erasureDisplayName({ id: '0193f2a1-0000-7000-8000-000000000000', employeeNo: 'E-0042' })
    expect(name).toBe('E-0042')
  })

  it('falls back to a token derived from the row id when there is no employee number', () => {
    const name = erasureDisplayName({ id: '0193f2a1-abcd-7000-8000-000000000000', employeeNo: null })
    expect(name).toBe('person-0193f2a1')
    // The id is already in the URL of every page about this person, so the token discloses nothing
    // the screen did not have — and two erased people still look different from each other, which
    // is what keeps a list of them countable.
    expect(name).not.toBe(erasureDisplayName({ id: 'ffffffff-0000-7000-8000-0', employeeNo: null }))
  })

  it('never produces an empty name, which the column and the contract both refuse', () => {
    for (const employeeNo of [null, '', '   '])
      expect(
        erasureDisplayName({ id: '0193f2a1-0000-7000-8000-000000000000', employeeNo }).length,
      ).toBeGreaterThan(0)
  })

  it('carries no language, so a Persian screen is not shown an English word', () => {
    const name = erasureDisplayName({ id: '0193f2a1-0000-7000-8000-000000000000', employeeNo: null })
    expect(name).not.toMatch(/erase|deleted|removed|anonym/i)
  })
})

describe('which history values are redacted', () => {
  it('redacts every field whose recorded value names a person', () => {
    for (const field of REDACTED_HISTORY_FIELDS) expect(isRedactableHistoryField(field), field).toBe(true)
  })

  it('redacts a custom field under any key an administrator chose', () => {
    // The reason this is a prefix and not a list: `custom.emergencyContactName` is exactly the kind
    // of key this rule exists for, and no fixed list could have anticipated it.
    expect(isRedactableHistoryField('custom.emergencyContactName')).toBe(true)
    expect(isRedactableHistoryField('custom.dietary')).toBe(true)
  })

  it('keeps the values behind the employment facts the erasure itself keeps', () => {
    // Clearing their history while the current value survives on `people` and `employments` leaves a
    // record whose present state nothing explains — worse than either alternative, and for no gain.
    for (const field of ['hiredOn', 'terminatedOn', 'status', 'employment', 'office', 'employeeNo'])
      expect(isRedactableHistoryField(field), field).toBe(false)
  })

  it('leaves `sensitive` rows alone, because they never held a value', () => {
    // `people.sensitive.update` records the *names* of the fields that changed and never their
    // contents. There is nothing in those rows to clear, and listing them would imply otherwise.
    expect(isRedactableHistoryField('sensitive')).toBe(false)
  })
})

describe('scrubbing a name out of a snapshot', () => {
  /** The shape `approval_requests.chain` actually holds — an `ApprovalChainSpec` snapshot. */
  interface Chain {
    steps: Array<{
      name: string
      mode: string
      minApprovals: number
      approvers: Array<{ kind: string; id?: string }>
    }>
  }
  const chain: Chain = {
    steps: [
      { name: 'Manager of Ayşe Demir', mode: 'any', minApprovals: 1, approvers: [{ kind: 'manager' }] },
      { name: 'Finance', mode: 'all', minApprovals: 2, approvers: [{ kind: 'person', id: 'u-1' }] },
    ],
  }

  it('replaces the name wherever it was copied, and leaves the structure alone', () => {
    const { value, changed } = scrubNames(chain, ['Ayşe Demir'], '#token')
    expect(changed).toBe(true)
    const out = value as typeof chain
    expect(out.steps[0]?.name).toBe('Manager of #token')
    expect(out.steps[1]?.name).toBe('Finance')
    // Structure, numbers and unrelated strings are untouched: the column is `not null` and is the
    // record of who had to sign, so the names come out and everything else stays exactly as it was.
    expect(out.steps[0]?.minApprovals).toBe(1)
    // `ApproverSubject` is a union and only some members carry an id — `manager` and
    // `org_unit_head` name a role rather than a person. Narrowed rather than asserted, so this
    // fails loudly if the scrub ever turns a `person` approver into a role.
    const approver = out.steps[1]?.approvers[0]
    expect(approver && 'id' in approver ? approver.id : undefined).toBe('u-1')
    expect(out.steps).toHaveLength(2)
  })

  it('matches without regard to case', () => {
    const { value } = scrubNames({ note: 'raised by AYŞE DEMIR' }, ['Ayşe Demir'], '#t')
    expect((value as { note: string }).note).toBe('raised by #t')
  })

  it('never rewrites a key, only a value', () => {
    // A key here is a field name a client renders from; rewriting one would break the document
    // rather than redact it.
    const { value } = scrubNames({ Ayse: 'Ayse' }, ['Ayse'], '#t')
    expect(Object.keys(value as object)).toEqual(['Ayse'])
    expect((value as Record<string, string>).Ayse).toBe('#t')
  })

  it('survives a name containing regex metacharacters', () => {
    // A display name is user input. Unescaped, `A. B (x)` is a pattern that matches almost anything
    // — or throws — and either outcome corrupts an approval snapshot.
    const { value, changed } = scrubNames({ s: 'filed by A. B (x)' }, ['A. B (x)'], '#t')
    expect(changed).toBe(true)
    expect((value as { s: string }).s).toBe('filed by #t')
    expect(scrubNames({ s: 'AxB (y)' }, ['A. B (x)'], '#t').changed).toBe(false)
  })

  it('ignores a needle too short to be safe', () => {
    // A one- or two-letter name would blank every string in the document — "Su" would turn every
    // "Tuesday" into a token. Better to leave a two-letter name in a workflow snapshot than to
    // shred the snapshot.
    const { value, changed } = scrubNames({ day: 'Tuesday' }, ['Su'], '#t')
    expect(changed).toBe(false)
    expect(value).toEqual({ day: 'Tuesday' })
  })

  it('reports no change and returns what it was given, which is what makes a replay a no-op', () => {
    // The caller skips the write when `changed` is false, so a second erasure reports zero rows for
    // this class instead of rewriting identical jsonb — the property the whole erasure rests on.
    const input = { steps: [{ name: 'Finance' }] }
    const { value, changed } = scrubNames(input, ['Ayşe Demir'], '#t')
    expect(changed).toBe(false)
    expect(value).toBe(input)
  })

  it('walks arrays and leaves non-strings as they are', () => {
    const { value } = scrubNames({ xs: ['Ayse', 7, null, true, { y: 'Ayse' }] }, ['Ayse'], '#t')
    expect(value).toEqual({ xs: ['#t', 7, null, true, { y: '#t' }] })
  })
})

describe('custom fields an administrator marked sensitive', () => {
  const custom = { shirtSize: 'L', nationalIdScan: 'abc', dietary: 'none' }

  it('drops the sensitive keys and keeps the rest', () => {
    expect(stripSensitiveCustom(custom, new Set(['nationalIdScan']))).toEqual({
      shirtSize: 'L',
      dietary: 'none',
    })
  })

  it('drops the key rather than nulling it', () => {
    // Unlike the four personnel fields, which are nulled and flagged with `personnelHidden`.
    // `custom` is an open record with no declared shape, so a null is indistinguishable from a
    // field nobody filled in — and rendering "National ID: —" to somebody who may not see it is a
    // worse answer than not rendering the row.
    const out = stripSensitiveCustom(custom, new Set(['nationalIdScan']))
    expect('nationalIdScan' in out).toBe(false)
  })

  it('does not mutate what it was given', () => {
    stripSensitiveCustom(custom, new Set(['nationalIdScan']))
    expect(custom.nationalIdScan).toBe('abc')
  })

  it('returns the same object when there is nothing to strip', () => {
    // The ordinary path — a reader who holds `hr.person.view_sensitive`, or a workspace with no
    // sensitive field defined — is a directory page of five hundred rows and must allocate nothing.
    expect(stripSensitiveCustom(custom, new Set())).toBe(custom)
    expect(stripSensitiveCustom(custom, new Set(['notAKeyHere']))).toBe(custom)
  })
})

describe('retention arithmetic', () => {
  it('counts back in whole days', () => {
    expect(retentionCutoff(1, '2026-03-02')).toBe('2026-03-01')
    expect(retentionCutoff(30, '2026-03-02')).toBe('2026-01-31')
  })

  it('crosses a month and a year boundary', () => {
    expect(retentionCutoff(1, '2026-01-01')).toBe('2025-12-31')
    expect(retentionCutoff(365, '2026-01-01')).toBe('2025-01-01')
  })

  it('gets a leap day right', () => {
    expect(retentionCutoff(1, '2024-03-01')).toBe('2024-02-29')
  })

  it('is UTC, so the answer does not depend on the machine that asked', () => {
    // A retention boundary that moves with a server's timezone is a boundary two instances of the
    // same deployment disagree about.
    expect(retentionCutoff(0, '2026-08-27')).toBe('2026-08-27')
    expect(retentionCutoff(3650, '2026-08-27')).toBe('2016-08-29')
  })
})

describe('the retention classes the contract declares and the service can count', () => {
  it('lists exactly the classes the contract names', () => {
    // A class in the contract that the service cannot count would show an administrator a horizon
    // with a permanently empty "what is past this" — a setting that appears to do nothing, which is
    // the defect this whole feature is written under.
    expect([...RETENTION_CLASSES].sort()).toEqual([...RetentionClass.options].sort())
  })

  it('gives every one of them a null default', () => {
    // Null means "keep indefinitely" and is the shipped value for every class. "Seven years" is a
    // fact about one country and one document class; the suggested figures belong in help text
    // beside the sentence saying Kern gives no legal advice, never in a default.
    expect(Object.keys(EMPTY_RETENTION).sort()).toEqual([...RetentionClass.options].sort())
    for (const value of Object.values(EMPTY_RETENTION)) expect(value).toBeNull()
    expect(HrRetention.parse({})).toEqual(EMPTY_RETENTION)
  })

  it('refuses a horizon that is not a whole number of days in range', () => {
    expect(HrRetention.safeParse({ punches: 0 }).success).toBe(false)
    expect(HrRetention.safeParse({ punches: 1.5 }).success).toBe(false)
    expect(HrRetention.safeParse({ punches: 36_501 }).success).toBe(false)
    expect(HrRetention.safeParse({ punches: 1825 }).success).toBe(true)
    expect(HrRetention.safeParse({ punches: null }).success).toBe(true)
  })
})

describe('the subject-access bundle', () => {
  it('caps every section it can truncate', () => {
    // A cap that bites is named in `manifest.truncated` with its numbers. A section with no cap is
    // the one that would take the process down on a pathological record instead.
    for (const [section, cap] of Object.entries(SECTION_CAPS)) {
      expect(cap, section).toBeGreaterThan(0)
      expect(Number.isInteger(cap), section).toBe(true)
    }
  })

  it('sizes the caps well above a five-year employee', () => {
    // Four punches a day over about 250 working days a year is ~5,000 punches and ~1,800 day
    // sheets. A normal record must never be cut, or every bundle carries a truncation notice and
    // nobody reads the next one.
    expect(SECTION_CAPS.punches).toBeGreaterThan(5_000)
    expect(SECTION_CAPS.attendanceDays).toBeGreaterThan(1_800)
    expect(SECTION_CAPS.leaveLedger).toBeGreaterThan(250)
  })

  it('sums the ledger in order', () => {
    // "Why is my balance this number" is the commonest follow-up a subject access request produces,
    // and a balance is the sum of the ledger and nothing else.
    expect(closingBalance([{ amountMinutes: 960 }, { amountMinutes: -480 }, { amountMinutes: 120 }])).toBe(
      600,
    )
    expect(closingBalance([])).toBe(0)
  })
})

/**
 * The privacy surface as data.
 *
 * `module.test.ts` already asserts the general rule for every procedure in the module. These are the
 * three properties specific to this feature that would compile perfectly while being wrong.
 */
describe('the privacy surface', () => {
  interface Leaf {
    '~orpc': { middlewares?: unknown[] }
  }
  const implemented = implement_({} as Kernel) as unknown as {
    privacy: {
      subjectAccess: Leaf
      erase: Leaf
      accessLog: { list: Leaf }
      retention: { get: Leaf; set: Leaf }
    }
  }
  const middlewares = (leaf: Leaf) => leaf['~orpc'].middlewares?.length ?? 0

  it('declares `hr.privacy.manage` as a deliberate grant, held by nobody', () => {
    const key = hrPermissions.filter((p) => p.key === 'hr.privacy.manage')
    expect(key, 'declared exactly once').toHaveLength(1)
    // The same shape as `hr.person.view_sensitive`: whether anybody below an owner may export or
    // erase a colleague is the workspace's decision, made in the role editor rather than inherited
    // by everybody who happens to be an admin.
    expect(key[0]?.defaultRoles).toEqual([])
    expect(key[0]?.dangerous).toBe(true)
  })

  it('gates every privacy procedure that is about somebody else', () => {
    // `workspaceScoped` + `requires('hr.privacy.manage')`. A key nothing asks about is the defect
    // the `hr.overtime.*` keys were removed for; this is the assertion that it is not one.
    expect(middlewares(implemented.privacy.subjectAccess)).toBeGreaterThanOrEqual(2)
    expect(middlewares(implemented.privacy.erase)).toBeGreaterThanOrEqual(2)
    expect(middlewares(implemented.privacy.retention.get)).toBeGreaterThanOrEqual(2)
    expect(middlewares(implemented.privacy.retention.set)).toBeGreaterThanOrEqual(2)
  })

  it('leaves reading your own access log ungated, behind the workspace gate alone', () => {
    // Reading who has looked at your own bank details is a thing nobody may lack, so a grantable
    // key here could only ever be one somebody could be denied. The check that `personId` is your
    // own — and that `actorUserId` is an investigation — is in the handler, where it can see the
    // arguments. It still proves a real membership and that the workspace has HR switched on.
    expect(middlewares(implemented.privacy.accessLog.list)).toBe(1)
  })

  it('makes the erasure a preview unless the caller asks for the act', () => {
    // The property this feature would be most dangerous without. Core generates an MCP tool from
    // every hosted module's OpenAPI document, so `POST /people/{id}/privacy/erase` is agent-callable
    // the day it ships — and the call made with no arguments has to be the harmless one.
    const input = hrContract.privacy.erase['~orpc'].inputSchema
    const parsed = (
      input as { parse: (v: unknown) => { dryRun: boolean; keepNationalIdForAudit: boolean } }
    ).parse({
      workspaceId: '0193f2a1-0000-7000-8000-000000000000',
      personId: '0193f2a1-0000-7000-8000-000000000001',
    })
    expect(parsed.dryRun).toBe(true)
    // And the national identity number goes unless somebody deliberately keeps it, which is the
    // direction a GDPR erasure request asks for.
    expect(parsed.keepNationalIdForAudit).toBe(false)
  })

  it('puts none of it behind a capability', () => {
    // A workspace that could switch privacy off would be one that stopped honouring subject
    // requests, which fails the capability registry's own rule that a switch must be reversible
    // without destroying data. Naming these there would also make `module.test.ts` demand a
    // `requiresCapability` that must not exist.
    const gated = new Set(Object.values(hrCapabilityProcedures).flat())
    for (const name of [
      'privacy.subjectAccess',
      'privacy.erase',
      'privacy.accessLog.list',
      'privacy.retention.get',
      'privacy.retention.set',
    ])
      expect(gated.has(name), name).toBe(false)
  })
})
