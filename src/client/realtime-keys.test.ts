import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { hrKeys } from './query.js'

/**
 * Every client query key must be reachable by the realtime invalidation the server sends.
 *
 * `@kernhq/ui`'s realtime client turns a `change` message into
 * `invalidateQueries({ queryKey: [module, entity] })` — a **prefix** match on the announced entity
 * name. So a key whose second segment is not one of the names `src/server` announces is a key no
 * other user's edit ever refreshes. Nothing else notices: the tab that made the change invalidates
 * its own keys explicitly and looks perfectly correct, a single-user e2e run and the dev mock have
 * no second tab to go stale, and the screen only lies when two people use it at once.
 *
 * The check is one-directional on purpose. Every *client* segment has to be an announced entity —
 * or a recorded exception below, of which there is exactly one — and an announced entity with no
 * key under it is fine: it means no screen caches that thing yet.
 */

const serverDir = fileURLToPath(new URL('../server', import.meta.url))
const clientDir = fileURLToPath(new URL('.', import.meta.url))

/** Every file under `dir` whose name ends in one of `exts`, minus the ones `skip` matches. */
function sources(dir: string, exts: readonly string[], skip: (name: string) => boolean): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => exts.some((ext) => name.endsWith(ext)) && !skip(name))
    .map((name) => `${dir}/${name}`)
}

const read = (files: string[]) => files.map((file) => readFileSync(file, 'utf8')).join('\n')

/**
 * The client files this file's regexes read.
 *
 * Tests included — `query.test.ts` pins several key shapes as literals, and an expectation written
 * the old way is the same defect as a component written the old way. This file is the exception:
 * its own regex sources and the probe literals below are not keys any screen uses.
 */
const clientSources = () =>
  sources(clientDir, ['.ts', '.svelte'], (name) => name.endsWith('realtime-keys.test.ts'))

/** The index of the quote closing the string that opens at `at`. */
function endOfString(text: string, at: number): number {
  const quote = text[at]
  for (let i = at + 1; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === quote) return i
  }
  return text.length
}

/**
 * The index of the `)` matching an opening paren whose body starts at `from`.
 *
 * Depth counting, skipping the parens inside string and template literals so an argument like
 * `')'` cannot close the call early. A paren inside a *comment* inside the call would still
 * confuse it; there are none, and an unbalanced one would show up as an entity going missing from
 * the set, which the floors below catch.
 */
function endOfCall(text: string, from: number): number {
  let depth = 1
  for (let i = from; i < text.length; i++) {
    const c = text[i]!
    if (c === "'" || c === '"' || c === '`') {
      i = endOfString(text, i)
      continue
    }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return text.length
}

/**
 * What `src/server` announces, by the two shapes the module writes them in.
 *
 * `viaHelper` is `changed(workspaceId, 'entity', id, op)`, the wrapper around
 * `kernel.realtime.change` at `router.ts:734`. `viaLiteral` is the object form,
 * `kernel.realtime.change(ws, { module, entity: 'entity', … })`, used where a call site does not
 * have the helper in scope.
 *
 * The object form is read out of the **span of a `kernel.realtime.change(` call**, not by grepping
 * the whole tree for `entity: '…'`. `entity` is an ordinary property name — `payrollAssembly` in
 * `router.ts` builds an export manifest with an `entity` field of its own — so a bare regex would
 * let any object literal anywhere in `src/server` widen what the client is allowed to spell, which
 * is the one thing this file exists to hold shut.
 *
 * The helper itself passes `entity` as a variable, and it is the only place that does. Add a
 * hand-maintained supplement, with the file and line that justifies it, the day another call site
 * starts computing the name.
 */
function announcedEntities(): { viaHelper: Set<string>; viaLiteral: Set<string>; all: Set<string> } {
  // Tests excluded: a fixture's entity name is not an announcement, and inventing one there would
  // widen what the client is allowed to spell.
  const text = read(sources(serverDir, ['.ts'], (name) => name.endsWith('.test.ts')))
  const viaHelper = new Set<string>()
  const viaLiteral = new Set<string>()
  for (const m of text.matchAll(/\bchanged\(\s*[^,\n]+,\s*'([a-z_]+)'/g)) viaHelper.add(m[1]!)

  const call = 'kernel.realtime.change('
  for (let at = text.indexOf(call); at !== -1; at = text.indexOf(call, at + call.length)) {
    const body = at + call.length
    const span = text.slice(body, endOfCall(text, body))
    for (const m of span.matchAll(/\bentity:\s*'([a-z_]+)'/g)) viaLiteral.add(m[1]!)
  }
  return { viaHelper, viaLiteral, all: new Set([...viaHelper, ...viaLiteral]) }
}

/** The second segment of every `['hr', '…'` key literal the client builds, and the files it is in. */
function clientSegments(): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const file of clientSources()) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/\['hr',\s*'([a-z0-9_-]+)'/g)) {
      const where = found.get(m[1]!) ?? []
      where.push(file.slice(clientDir.length))
      found.set(m[1]!, where)
    }
  }
  return found
}

/**
 * Source with its comments removed, so a *sentence about* a key shape is not mistaken for one.
 *
 * Line comments to end of line, block comments to their terminator, and `<!-- … -->` for the markup
 * half of a `.svelte` file.
 * String and template literals are copied through intact, which is what stops a `//` inside a URL
 * from swallowing the rest of a line. A regex literal containing `//` would still be misread; there
 * is none in `src/client`, and the guard below fails loudly rather than quietly if that changes.
 */
function withoutComments(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      out += ' '
      continue
    }
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4)
      i = end === -1 ? text.length : end + 2
      out += ' '
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const end = endOfString(text, i)
      out += text.slice(i, end + 1)
      i = end
      continue
    }
    out += c
  }
  return out
}

/**
 * The keys that are deliberately **not** named after an announced entity, and why.
 *
 * There is one, and it is the most sensitive screen in the module. Everything else in this file
 * assumes an unreachable key is a defect; these are the ones where being reached is the defect, so
 * they are recorded here rather than fixed. The test below holds the list to both directions — an
 * exception nothing in `src/client` uses any more is deleted, not left standing as cover for the
 * next stray.
 */
const RECORD_EXCEPTIONS: Record<string, string> = {
  sensitive: [
    'the encrypted half of a person record, off the `person` prefix on purpose. The server writes a',
    '`sensitive_access_log` row for every read, so under `person` any person announcement — a',
    'rename, a checklist tick, a retention sweep — would refetch a revealed panel and log a',
    'disclosure nobody performed: the viewer did not ask, the cache did. Staleness is the safer',
    'failure here, so cross-user invalidation is intentionally not received; the panel fetches when',
    'the viewer reveals it, and the screen’s own write invalidates this key explicitly.',
  ].join(' '),
}

/** Representative report inputs, so a report key can be built here the way a screen builds it. */
const RANGE = { from: '2026-01-01', to: '2026-01-31', by: 'workspace' as const, limit: 50 }
const BALANCE = { asOf: '2026-01-31', by: 'workspace' as const, limit: 50 }

/** A key that is named after an entity, but not after *its own* name — with the proof of both. */
interface DerivedKey {
  /** The announced entity the key sits under. */
  entity: string
  /**
   * Why that entity — and, where it does not cover every write the screen's data has, what it
   * misses. A why that claims more coverage than the prefix delivers is worse than none: it is
   * what stops the next reader noticing the gap.
   */
  why: string
  /** The key as it is really built, so the entity claim above is checked rather than described. */
  probe: () => readonly unknown[]
  /**
   * Where a key is built by hand instead of by `hrKeys`, so `probe` is a copy of a literal. The
   * test greps that file for the literal, which is what keeps the copy from drifting.
   */
  inFile?: string
  /**
   * The segment the screen's own word survives as, when it is not the index word itself — some are
   * shortened once the entity in front carries half the meaning (`payroll-export-preview` under
   * `period` is `export-preview`). `null` where the word did not survive as a segment at all.
   */
  word?: string | null
}

/**
 * The keys whose entity is not their own name, and why that entity is the right one.
 *
 * Indexed by the word the key used to lead with, which is also what the last test below refuses to
 * see back in the entity slot. A direct rename — `offices` to `office`, `leave-requests` to
 * `leave_request` — needs no entry: the old spelling and the new one are the same noun. These are
 * the keys that ask a question no announcement is named after, so the answer had to be read out of
 * what the *server* does when the screen's data changes.
 */
const DERIVED_KEYS: Record<string, DerivedKey> = {
  'access-log': {
    entity: 'person',
    why: 'one person’s disclosure history; an erase rewrites it and announces the person',
    probe: () => hrKeys.accessLog('ws', 'p1'),
  },
  'accrual-preview': {
    entity: 'leave_balance',
    why: 'projects what a run would grant, and `accrual.run` announces leave_balance',
    probe: () => ['hr', 'leave_balance', 'ws', 'accrual-preview', '2026-01-01', '2026-12-31'],
    inFile: 'settings/AccrualSettings.svelte',
  },
  'calendar-days': {
    entity: 'calendar',
    why: 'the days of one calendar',
    probe: () => hrKeys.calendarDays('ws', 'cal', '2026-01-01', '2026-01-31'),
    word: 'days',
  },
  'calendar-pack-preview': {
    entity: 'calendar',
    why: 'a diff of a holiday pack against one calendar',
    probe: () => hrKeys.calendarPackPreview('ws', 'cal', 'ir', 2026),
    word: 'pack-preview',
  },
  'calendar-working-days': {
    entity: 'calendar',
    why: 'the composed working days of one calendar',
    probe: () => hrKeys.calendarWorkingDays('ws', 'cal', '2026-01-01', '2026-01-31'),
    word: 'working-days',
  },
  'clock-state': {
    entity: 'attendance_day',
    why: 'a punch rebuilds the day sheet and announces it; that is what the clock reads',
    probe: () => hrKeys.clockState('ws'),
  },
  documents: {
    entity: 'person',
    why: 'attach and remove both announce the person the document hangs off',
    probe: () => hrKeys.documents('ws', 'p1'),
  },
  employment: {
    entity: 'person',
    why: '`employment.change` announces the person whose job changed',
    probe: () => hrKeys.employment('ws', 'p1'),
  },
  'employment-history': {
    entity: 'person',
    why: 'the same write, read as a list',
    probe: () => hrKeys.employmentHistory('ws', 'p1'),
  },
  'leave-calendar': {
    entity: 'leave_request',
    why: 'who is away is the approved requests; filing and cancelling announce those',
    probe: () => hrKeys.leaveCalendar('ws', '2026-01-01', '2026-01-31'),
    word: 'calendar',
  },
  'leave-ledger': {
    entity: 'leave_balance',
    why: 'the entries behind a balance; adjust and accrual announce leave_balance',
    probe: () => hrKeys.leaveLedger('ws', 'p1', 'lt1', 2026),
    word: 'ledger',
  },
  'leave-sim': {
    entity: 'leave_balance',
    why: 'the simulation is measured against the asker’s balance and refuses on it',
    probe: () => ['hr', 'leave_balance', 'ws', 'leave-sim', 'lt1', '2026-01-01', '2026-01-05'],
    inFile: 'components/LeaveRequestDialog.svelte',
  },
  me: {
    entity: 'person',
    why: '`people.me` answers with a person record',
    probe: () => hrKeys.me('ws'),
  },
  'office-people': {
    entity: 'person',
    why: '`offices.assign` and `unassign` announce the person they moved, not the office',
    probe: () => hrKeys.officePeople('ws', 'o1', true),
  },
  'payroll-export-preview': {
    entity: 'period',
    why: 'its refusals and finality follow the period lock, which `periods.*` announce',
    probe: () => hrKeys.payrollExportPreview('ws', 'le1', 'per1', true),
    word: 'export-preview',
  },
  punches: {
    entity: 'attendance_day',
    why: 'a punch and a void both announce the day they rebuilt',
    probe: () => ['hr', 'attendance_day', 'ws', 'punches', 'me', '2026-01-05'],
    inFile: 'components/DayDetail.svelte',
  },
  'report-absence': {
    entity: 'attendance_day',
    why: [
      'counted off the day sheets, which every punch announces — the dominant write. It is not the',
      'whole population: `services/reports.ts` also left-joins approved `leave_request_days` to tell',
      'an absence from a day off, and that leg moves only on a `leave_request` announcement. An',
      'approval decision announces `approval` and nothing else, so a colleague approving leave does',
      'not reach this report until the server announces the request it decided.',
    ].join(' '),
    probe: () => hrKeys.reportAbsence('ws', RANGE),
  },
  'report-attendance': {
    entity: 'attendance_day',
    why: 'counted off the day sheets, which every punch announces',
    probe: () => hrKeys.reportAttendance('ws', RANGE),
  },
  'report-leave-balance': {
    entity: 'leave_balance',
    why: [
      'the balances as at a date: an adjustment and an accrual run write the ledger it sums and both',
      'announce leave_balance, which are the dominant writes. `services/reports.ts` also aggregates',
      'the live pending and approved requests on top, and only a `leave_request` announcement moves',
      'those — so a colleague filing or having leave approved is the residual this prefix misses.',
    ].join(' '),
    probe: () => hrKeys.reportLeaveBalance('ws', BALANCE),
  },
  'report-overtime': {
    entity: 'attendance_day',
    why: 'counted off the day sheets, and it shares the absence report’s leave residual',
    probe: () => hrKeys.reportOvertime('ws', RANGE),
  },
  resolution: {
    entity: 'person',
    why: [
      'the office ladder moves when an assignment does, which announces the person. The residual is',
      'the office itself: `services/resolve.ts` reads its timezone and calendarId and the calendar',
      'row behind them, and those writes announce `office` and `calendar` — neither reaches a',
      '`person`-prefixed key, so an office’s timezone edit arrives only on a reload.',
    ].join(' '),
    probe: () => hrKeys.resolution('ws', 'p1'),
  },
  retention: {
    entity: 'retention_run',
    why: [
      'the counts beside each horizon are what a sweep changes, and a run announces retention_run.',
      'The horizons themselves are covered by no prefix: `privacy.retention.set` announces nothing',
      'at all, so a second admin’s save reaches this screen only on a reload — what refreshes it is',
      'a sweep and the screen’s own write, which invalidates the key directly.',
    ].join(' '),
    probe: () => hrKeys.retention('ws'),
    // `retention` survives only inside the entity name; the screen's own word became `settings`.
    word: null,
  },
}

describe('realtime query keys', () => {
  const announced = announcedEntities()
  const segments = clientSegments()

  /**
   * Every extraction here is a regex or a scan over source, so every one of them can silently match
   * nothing — and a check that compares an empty set against an empty set passes. These assertions
   * are what make the ones below mean something.
   *
   * The client is counted by *site* rather than by distinct segment: once every key is named after
   * an entity, the distinct count cannot exceed the entity list, so it is the wrong number to hold
   * a floor under. A regex that stops matching shows up in the site count immediately. The object
   * form is floored separately, because it is the one the span scanner reads and a scanner that
   * found no spans would leave the helper's names looking like the whole story.
   */
  it('extracts enough to be checking anything at all', () => {
    expect(announced.viaHelper.size).toBeGreaterThanOrEqual(20)
    expect(announced.viaLiteral.size).toBeGreaterThanOrEqual(4)
    expect(announced.all.size).toBeGreaterThanOrEqual(20)
    expect(segments.size).toBeGreaterThanOrEqual(20)
    const sites = [...segments.values()].reduce((n, files) => n + files.length, 0)
    expect(sites).toBeGreaterThanOrEqual(90)
  })

  it('names every client key after an entity the server announces', () => {
    const strays = [...segments]
      .filter(([segment]) => !announced.all.has(segment) && !(segment in RECORD_EXCEPTIONS))
      .map(([segment, files]) => `${segment} (${[...new Set(files)].join(', ')})`)
    expect(strays).toEqual([])
  })

  /**
   * The exception list is held to both directions. A segment nobody builds any more is not a
   * harmless leftover: it is a hole the next stray key falls through unnoticed, and it reads as a
   * standing decision long after the screen it was written for is gone.
   */
  it('keeps no recorded exception the client has stopped using', () => {
    for (const [segment, why] of Object.entries(RECORD_EXCEPTIONS))
      expect({ segment, used: segments.has(segment), explained: why.length > 0 }).toEqual({
        segment,
        used: true,
        explained: true,
      })
  })

  it('maps every derived key onto an entity that is announced, with a reason', () => {
    for (const [key, { entity, why }] of Object.entries(DERIVED_KEYS))
      expect({ key, announced: announced.all.has(entity), explained: why.length > 0 }).toEqual({
        key,
        announced: true,
        explained: true,
      })
  })

  /**
   * And the mapping is *built*, not merely asserted in prose.
   *
   * The table above is only worth reading if `documents` really does come out under `person`. So
   * every entry builds its key — through `hrKeys` where a helper owns it — and the entity slot and
   * the surviving word are read back off the tuple. Both directions on the word: a `null` claim is
   * checked as hard as a positive one, or it becomes the way to opt out of the check.
   */
  it('builds every derived key under the entity it claims', () => {
    for (const [key, { entity, probe, word }] of Object.entries(DERIVED_KEYS)) {
      const built = probe()
      expect({ key, module: built[0], entity: built[1] }).toEqual({ key, module: 'hr', entity })
      // The workspace is the third segment; anything telling two questions apart comes after it.
      const scope = built.slice(2).map((part) => JSON.stringify(part))
      const surviving = word === undefined ? key : word
      if (surviving === null)
        expect({ key, relapsed: scope.includes(`"${key}"`) }).toEqual({ key, relapsed: false })
      else {
        // A shortening, not a rewrite: `pack-preview` is part of `calendar-pack-preview`.
        expect({ key, shortening: key.includes(surviving) }).toEqual({ key, shortening: true })
        expect({ key, carries: scope.includes(`"${surviving}"`) }).toEqual({ key, carries: true })
      }
    }
  })

  /**
   * A probe for a key `hrKeys` does not own is a copy of a literal in a component, and a copy is
   * only evidence while the two agree. This greps the component for the shape the probe claims.
   */
  it('finds every hand-built derived key in the file that builds it', () => {
    for (const [key, { entity, inFile, word }] of Object.entries(DERIVED_KEYS)) {
      if (!inFile) continue
      const text = readFileSync(`${clientDir}${inFile}`, 'utf8')
      const needle = `['hr', '${entity}', workspaceId, '${word ?? key}'`
      expect({ key, inFile, found: text.includes(needle) }).toEqual({ key, inFile, found: true })
    }
  })

  /**
   * The table above documents a rename that has happened, not one that is planned. A screen word
   * back in the entity slot is the defect coming back.
   */
  it('leaves no derived key in the entity slot', () => {
    const relapsed = Object.keys(DERIVED_KEYS).filter((key) => segments.has(key))
    expect(relapsed).toEqual([])
  })

  /**
   * `clientSegments` only sees a key whose entity is spelt as a literal, which is every key today.
   * A key built as `['hr', SOME_CONST, …]` would be invisible to it — extracted as nothing, checked
   * against nothing, and free to name anything at all. So a second segment that is not a string is
   * refused outright: spell the entity, and the rule above applies to it like every other key.
   *
   * Comments are stripped first. Two files describe the shape in prose — `['hr', entity, workspace,
   * …scope]` — and a sentence about a key is not a key.
   */
  it('spells every entity as a literal, never a variable', () => {
    const computed: string[] = []
    for (const file of clientSources()) {
      const text = withoutComments(readFileSync(file, 'utf8'))
      for (const m of text.matchAll(/\['hr',\s*(?!')(?!\/[/*])([a-zA-Z_$])/g))
        computed.push(`${file.slice(clientDir.length)}: ['hr', ${m[1]}…`)
    }
    expect(computed).toEqual([])
  })
})
