/**
 * What the two "my own record" pages draw, and what a refused cancellation says.
 *
 * Neither page had an error branch. Attendance fell through to "Nothing recorded yet — clock in to
 * start" when the load *failed*, above three tiles reading 0h / 0h / 0h reduced from `[]` — a
 * confident statement about somebody's month made out of nothing, and the one figure here a person
 * might take to their manager. Time off dropped its balance strip with no message and then said "No
 * time off booked", which reads as a person with nothing rather than as a screen that never loaded.
 * A screenshot of the happy path cannot see any of that, and the mock this module develops against
 * has no way to refuse a call — so the branches are read out of the components themselves.
 *
 * The technique is `ClockControls.test.ts`'s, and the reasons are the same: there is no component
 * renderer in this package, so this parses each page with the compiler Svelte ships and evaluates
 * the `{#if}` chains, the derived flags that steer them, and `cancelFailure` — the file's own
 * source, run, rather than a copy of it restated here.
 *
 * What it cannot see: layout, colour, and anything CSS decides. Those are checked by eye and by
 * `shell`'s `ux.spec.ts`.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'svelte/compiler'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

interface Node {
  type: string
  start: number
  end: number
  [key: string]: unknown
}
/** An `IfBlock`, with the three children the chain walk reads named rather than fished out. */
interface IfNode extends Node {
  test: Node
  consequent: { nodes: Node[] }
  alternate?: { nodes: Node[] } | null
  elseif?: boolean
}
type Scope = Record<string, unknown>

/** One parsed page, with the handful of questions these tests ask of it. */
function page(file: string) {
  const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')
  const ast = parse(source, { modern: true })
  const slice = (node: Node) => source.slice(node.start, node.end)

  /** Every `{#if}` in the markup, innermost included, in source order. */
  const allIfBlocks = (): Node[] => {
    const found: Node[] = []
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(walk)
      const record = node as Record<string, unknown>
      if (record.type === 'IfBlock') found.push(record as Node)
      for (const value of Object.values(record)) if (value && typeof value === 'object') walk(value)
    }
    walk(ast.fragment)
    return found.sort((a, b) => a.start - b.start)
  }

  /**
   * The markup between two offsets with every `{#if}` inside it taken or dropped.
   *
   * The nested blocks are the point. Reading a branch's source *text* would put the stale notice and
   * the month in it whatever the query was doing, so an assertion for either passed against a
   * component that draws neither.
   */
  function resolve(from: number, to: number, scope: Scope): string {
    const inside = allIfBlocks().filter((b) => b.start >= from && b.end <= to)
    // Outermost first: a nested block is spliced in by the recursion into whichever side survives,
    // not by this loop, or it would appear twice.
    const blocks = inside.filter((b) => !inside.some((o) => o !== b && o.start <= b.start && o.end >= b.end))
    let out = ''
    let cursor = from
    for (const block of blocks) {
      out += source.slice(cursor, block.start)
      out += resolveIf(block, scope)
      cursor = block.end
    }
    return out + source.slice(cursor, to)
  }

  /** Resolve one `{#if}` chain against the scope and render whichever side it takes. */
  function resolveIf(block: Node, scope: Scope): string {
    const holds = new Function(...Object.keys(scope), `return (${slice(block.test as Node)})`)(
      ...Object.values(scope),
    )
    const side = holds
      ? (block.consequent as { nodes: Node[] })
      : (block.alternate as { nodes: Node[] } | null)
    if (!side || side.nodes.length === 0) return ''
    const nodes = side.nodes
    return resolve(nodes[0]!.start, nodes[nodes.length - 1]!.end, scope)
  }

  /** The `{#if}` chain whose first test is written exactly like this, found by that test. */
  const chain = (test: string): IfNode => {
    const found = allIfBlocks().filter((b) => slice(b.test as Node) === test && !b.elseif)
    expect({ test, matches: found.length }).toEqual({ test, matches: 1 })
    return found[0] as IfNode
  }

  /**
   * That chain's tests, in the order the renderer tries them, with `null` for the closing `{:else}`.
   *
   * The order is the whole assertion these support: every branch of these chains can draw
   * *something*, so "renders an error state" holds just as well of a page that draws it above the
   * data and blanks a working screen on a failed background refetch.
   */
  function branches(test: string): Array<string | null> {
    const out: Array<string | null> = []
    let block: IfNode | undefined = chain(test)
    while (block) {
      out.push(slice(block.test))
      const alternate = block.alternate
      if (!alternate) break
      const elseif = alternate.nodes.find((n) => n.type === 'IfBlock' && n.elseif) as IfNode | undefined
      if (elseif) {
        block = elseif
        continue
      }
      out.push(null)
      break
    }
    return out
  }

  /**
   * What that chain draws for this scope.
   *
   * Comments are stripped: a branch that *explains* in prose why it does not blank the page would
   * otherwise satisfy an assertion about what it renders.
   */
  const render = (test: string, scope: Scope): string =>
    resolveIf(chain(test), scope).replace(/<!--[\s\S]*?-->/g, '')

  /** The initialiser of one top-level `const` in the instance script. */
  function init(name: string): string {
    const found: Node[] = []
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(walk)
      const record = node as Record<string, unknown>
      if (record.type === 'VariableDeclarator' && (record.id as { name?: string })?.name === name)
        found.push(record.init as Node)
      for (const value of Object.values(record)) if (value && typeof value === 'object') walk(value)
    }
    walk(ast.instance?.content)
    expect({ name, matches: found.length }).toEqual({ name, matches: 1 })
    return slice(found[0]!)
  }

  /**
   * The expression inside a `const x = $derived(…)`, so the flag under test is the file's own.
   *
   * The trailing comma matters: biome wraps a long `$derived(…)` across lines and leaves one, and
   * `return ((…),)` is a syntax error rather than a failing assertion — which reads like the
   * component is broken when it is this helper that is.
   */
  function derived(name: string): string {
    const source = init(name)
    expect(source.startsWith('$derived(')).toBe(true)
    return source.slice('$derived('.length, -1).trim().replace(/,$/, '')
  }

  /** Evaluate one of the page's `$derived` flags against a scope. */
  const flag = (name: string, scope: Scope): unknown =>
    new Function(...Object.keys(scope), `return (${derived(name)})`)(...Object.values(scope))

  /** A `const` holding an arrow function, transpiled so its annotations do not reach `Function`. */
  const arrow = (name: string): string =>
    ts.transpileModule(`const ${name} = ${init(name)}`, {
      compilerOptions: { target: ts.ScriptTarget.ESNext },
    }).outputText

  /** A named `function` declaration from the instance script, with its types stripped. */
  function fn(name: string): string {
    const found: Node[] = []
    const walk = (node: unknown) => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(walk)
      const record = node as Record<string, unknown>
      if (record.type === 'FunctionDeclaration' && (record.id as { name?: string })?.name === name)
        found.push(record as Node)
      for (const value of Object.values(record)) if (value && typeof value === 'object') walk(value)
    }
    walk(ast.instance?.content)
    expect({ name, matches: found.length }).toEqual({ name, matches: 1 })
    return ts.transpileModule(slice(found[0]!), {
      compilerOptions: { target: ts.ScriptTarget.ESNext },
    }).outputText
  }

  return { source, branches, render, flag, arrow, fn }
}

const attendance = page('./AttendancePage.svelte')
const leave = page('./LeavePage.svelte')

/** A day sheet row, shaped enough for the `{#if}`s inside the month list. */
const day = { overtimeMinutes: 0, anomalies: [] as unknown[], businessDate: '2026-08-03' }
/**
 * What an expandable row reads besides the day itself: whether a correction is waiting on this
 * date, and whether this row is the open one. Both live outside the `{#each}`, so the resolver has
 * to be handed them or every render of the month throws.
 */
const row = { correctionDates: new Set<string>(), open: false }

describe('the month on the attendance page', () => {
  /**
   * The order is the assertion. Every one of these branches can draw *something*, so "renders a
   * skeleton when loading" was true of a page that asked `isError` first and blanked a working
   * month on a failed background refetch.
   */
  it('asks loading first, then the month it holds, then the failure, then the empty month', () => {
    expect(attendance.branches('loading')).toEqual(['loading', 'days.length', 'daysQuery.isError', null])
  })

  it('draws a day-shaped skeleton while the first fetch is in flight', () => {
    const body = attendance.render('loading', { loading: true, days: [], daysQuery: {}, day, ...row })
    expect(body).toContain('Skeleton')
    expect(body).not.toContain('EmptyState')
  })

  /**
   * The defect this file was written for. `days` is `[]` before an answer and `[]` after a refused
   * one, so the page said "Nothing recorded yet — clock in to start" to somebody whose month simply
   * had not loaded.
   */
  it('says the month failed and offers a retry rather than claiming nothing is recorded', () => {
    const body = attendance.render('loading', {
      loading: false,
      days: [],
      daysQuery: { isError: true },
      day,
      ...row,
    })
    expect(body).toContain("t('attendance_error')")
    expect(body).toContain("t('retry')")
    expect(body).not.toContain("t('attendance_none')")
  })

  it('still says nothing is recorded when the answer arrived and the month is genuinely empty', () => {
    const body = attendance.render('loading', {
      loading: false,
      days: [],
      daysQuery: { isError: false },
      day,
      ...row,
    })
    expect(body).toContain("t('attendance_none')")
    expect(body).not.toContain("t('attendance_error')")
  })

  /**
   * A punch invalidates the whole module, so a refetch that fails while the last good month is
   * still in `data` is the ordinary case — an error branch above the month would blank the page,
   * tiles included, for as long as core takes to come back.
   */
  it('keeps a held month when a refetch fails, and says it may be out of date', () => {
    const body = attendance.render('loading', {
      loading: false,
      days: [{ id: 'a' }],
      daysQuery: { isError: true },
      day,
      ...row,
    })
    expect(body).toContain('{#each days as day (day.id)}')
    expect(body).toContain("t('attendance_stale')")
    expect(body).toContain("t('retry')")
    expect(body).not.toContain("t('attendance_error')")
  })

  it('does not say the month may be out of date while the refetch is succeeding', () => {
    const body = attendance.render('loading', {
      loading: false,
      days: [{ id: 'a' }],
      daysQuery: { isError: false },
      day,
      ...row,
    })
    expect(body).toContain('{#each days as day (day.id)}')
    expect(body).not.toContain("t('attendance_stale')")
  })

  /**
   * The anomaly badge used to be `{day.anomalies.length}` — a number in a warning tone with no
   * noun beside it and nothing to click. It counts things a person has to look at, so it says so,
   * and the sentences behind it are one row-click away.
   */
  it('names what the anomaly badge counts rather than showing a bare number', () => {
    const body = attendance.render('loading', {
      loading: false,
      days: [{ id: 'a' }],
      daysQuery: { isError: false },
      day: { ...day, anomalies: ['missing_clock_out'] },
      ...row,
    })
    expect(body).toContain("t('att_anomalies_count', { count: day.anomalies.length })")
    expect(body).not.toContain('<Badge tone="warning">{day.anomalies.length}</Badge>')
  })
})

describe('the attendance tiles', () => {
  /**
   * Worked, scheduled and overtime are `days.reduce(…)`, so an unloaded month adds up to "0h worked,
   * 0h scheduled, 0h overtime" — three confident falsehoods about somebody's hours. There is nothing
   * to say until there is a day sheet to say it from.
   */
  it('is unknown, not zero, when the load failed with nothing held', () => {
    expect(attendance.flag('totalsUnknown', { days: [], loading: false, daysQuery: { isError: true } })).toBe(
      true,
    )
  })

  it('is unknown while the first fetch is in flight', () => {
    expect(attendance.flag('totalsUnknown', { days: [], loading: true, daysQuery: { isError: false } })).toBe(
      true,
    )
  })

  /** A month that really is empty is worth 0h, and saying so is the truth rather than a guess. */
  it('is known when the answer arrived and the month is empty', () => {
    expect(
      attendance.flag('totalsUnknown', { days: [], loading: false, daysQuery: { isError: false } }),
    ).toBe(false)
  })

  /** The held totals outrank a failed refetch, for the same reason the held month does. */
  it('is known when a refetch failed but the month is still held', () => {
    expect(
      attendance.flag('totalsUnknown', { days: [{ id: 'a' }], loading: false, daysQuery: { isError: true } }),
    ).toBe(false)
  })

  it('draws skeletons in place of the tiles rather than reducing an empty month', () => {
    expect(attendance.render('totalsUnknown', { totalsUnknown: true })).toContain('tilesUnknown()')
    expect(attendance.render('totalsUnknown', { totalsUnknown: false })).toContain('tiles()')
    expect(attendance.source).toContain('<Skeleton height="86px" />')
  })

  /**
   * A disabled query is `pending` and not fetching, so it is not "loading" — without the workspace
   * test the first frame told somebody with a full month that nothing was recorded.
   */
  it('counts the frame before a workspace arrives as loading', () => {
    expect(attendance.flag('loading', { workspaceId: '', daysQuery: { isLoading: false } })).toBe(true)
  })
})

describe('the balance on the time-off page', () => {
  it('asks loading first, then the balance it holds, then the failure, then the unconfigured workspace', () => {
    expect(leave.branches('balanceLoading')).toEqual([
      'balanceLoading',
      'balances.length',
      'balanceQuery.isError',
      null,
    ])
  })

  /**
   * The defect. A refused balance took the strip off the page with no message at all, leaving "No
   * time off booked" underneath it — which reads as a person with nothing left and nothing booked.
   */
  it('says the balance failed and offers a retry rather than dropping the strip', () => {
    const body = leave.render('balanceLoading', {
      balanceLoading: false,
      balances: [],
      balanceQuery: { isError: true },
      canHr: () => true,
    })
    expect(body).toContain("t('balance_error')")
    expect(body).toContain("t('retry')")
    expect(body).not.toContain("t('leave_types_none')")
  })

  /**
   * An empty answer is one row per leave type and no leave types — a workspace nobody has set up,
   * not a person with nothing. The way out is only offered to somebody who has it: a member cannot
   * create a leave type, and a button that 404s is worse than none.
   */
  it('names the unconfigured workspace when the answer arrived empty, and offers the fix only to an admin', () => {
    const scope = { balanceLoading: false, balances: [], balanceQuery: { isError: false } }
    const admin = leave.render('balanceLoading', { ...scope, canHr: () => true })
    expect(admin).toContain("t('leave_types_none')")
    expect(admin).toContain("t('leave_types')")
    expect(admin).not.toContain("t('balance_error')")

    const member = leave.render('balanceLoading', { ...scope, canHr: () => false })
    expect(member).toContain("t('leave_types_none')")
    expect(member).not.toContain("t('leave_types')")
  })

  it('draws skeletons the shape of the tiles while the first fetch is in flight', () => {
    const body = leave.render('balanceLoading', {
      balanceLoading: true,
      balances: [],
      balanceQuery: {},
      canHr: () => true,
    })
    expect(body).toContain('Skeleton')
    expect(body).not.toContain('EmptyState')
  })
})

describe('the requests on the time-off page', () => {
  const row = { status: 'pending' }
  const scope = { canCancel: () => true, request: row, canHr: () => true }

  it('asks loading first, then the requests it holds, then the failure, then the empty list', () => {
    expect(leave.branches('requestsLoading')).toEqual([
      'requestsLoading',
      'requests.length',
      'requestsQuery.isError',
      null,
    ])
  })

  it('says the list failed and offers a retry rather than claiming nothing is booked', () => {
    const body = leave.render('requestsLoading', {
      ...scope,
      requestsLoading: false,
      requests: [],
      requestsQuery: { isError: true },
    })
    expect(body).toContain("t('leave_requests_error')")
    expect(body).toContain("t('retry')")
    expect(body).not.toContain("t('leave_none')")
  })

  it('still says nothing is booked when the answer arrived and the list is genuinely empty', () => {
    const body = leave.render('requestsLoading', {
      ...scope,
      requestsLoading: false,
      requests: [],
      requestsQuery: { isError: false },
    })
    expect(body).toContain("t('leave_none')")
    expect(body).not.toContain("t('leave_requests_error')")
  })

  /**
   * One strip for both queries: when core is unreachable both fail, and two identical warnings
   * stacked on one page is noise.
   */
  it('warns that held data may be out of date, for either query, and never with nothing to hold', () => {
    const held = { balances: [{}], requests: [{}] }
    const none = { balances: [], requests: [] }
    const ok = { isError: false }
    const bad = { isError: true }
    expect(leave.flag('stale', { ...held, balanceQuery: bad, requestsQuery: ok })).toBe(true)
    expect(leave.flag('stale', { ...held, balanceQuery: ok, requestsQuery: bad })).toBe(true)
    expect(leave.flag('stale', { ...held, balanceQuery: ok, requestsQuery: ok })).toBe(false)
    // Nothing held is the error branch's job; a warning strip above an error state says it twice.
    expect(leave.flag('stale', { ...none, balanceQuery: bad, requestsQuery: bad })).toBe(false)
  })
})

describe('cancelling a booking', () => {
  /**
   * The defect. A small ghost button beside a status badge was `onclick={() => cancel.mutate(id)}`,
   * and `canCancel` allows an *approved* request — so one misclick destroyed a granted week: days
   * already off the balance, and an absence colleagues had planned around.
   */
  it('opens a confirmation instead of cancelling on the click', () => {
    const row = leave.render('requestsLoading', {
      requestsLoading: false,
      requests: [{}],
      requestsQuery: { isError: false },
      canCancel: () => true,
      request: { status: 'approved' },
      canHr: () => true,
    })
    expect(row).toContain("t('cancel_request')")
    expect(row).toContain('cancelling = request')
    expect(row).not.toContain('cancel.mutate')
    // window.confirm is not a dialog anybody can read, style or translate.
    expect(leave.source).not.toContain('confirm(')
  })

  /** Hidden from somebody who may never cancel; offered for the two statuses that can be. */
  it('is offered for a pending or approved booking, and only with the permission', () => {
    const build = new Function('canHr', `${leave.arrow('canCancel')}; return canCancel`)
    const allowed = build(() => true)
    expect(['pending', 'approved'].map(allowed)).toEqual([true, true])
    expect(['rejected', 'withdrawn', 'cancelled'].map(allowed)).toEqual([false, false, false])
    expect(allowed('pending')).toBe(true)
    expect(build(() => false)('pending')).toBe(false)
  })

  /**
   * "Are you sure?" says nothing. The body names the dates and the working days that come back, and
   * an approved booking gets a line of its own — those are the days the team has already planned
   * around, and the person clicking is the only one who can weigh that.
   */
  it('states the dates, the days returned and — for an approved booking — the team calendar', () => {
    const approved = leave.render('cancelling', {
      cancelling: { workingDays: 5, startsOn: '2026-09-09', endsOn: '2026-09-13', status: 'approved' },
      dateRange: () => '',
    })
    expect(approved).toContain("t('leave_cancel_body'")
    expect(approved).toContain('count: cancelling.workingDays')
    expect(approved).toContain('range: dateRange(cancelling.startsOn, cancelling.endsOn)')
    expect(approved).toContain("t('leave_cancel_approved')")

    const pending = leave.render('cancelling', {
      cancelling: { workingDays: 1, startsOn: '2026-09-09', endsOn: '2026-09-09', status: 'pending' },
      dateRange: () => '',
    })
    expect(pending).toContain("t('leave_cancel_body'")
    expect(pending).not.toContain("t('leave_cancel_approved')")
  })

  /**
   * `disabled={cancel.isPending}` reaches the button on the *next* render, so two quick clicks both
   * fire — and the second arrives at a request the first already cancelled, which the server refuses
   * for something the person did not do.
   */
  it('guards the second click in the same tick as the first', () => {
    expect(leave.source).toContain('let cancelInFlight = $state(false)')
    expect(leave.source).toMatch(/if \(!cancelling \|\| cancelInFlight\) return\s+cancelInFlight = true/)
  })
})

/**
 * `t()` as the runtime resolves it: this module's prefix on a bare key, and — the half `cancelFailure`
 * turns on — the key itself when nothing defines a string for it. `t()` is tested where it lives
 * (`packages/ui/src/lib/i18n.test.ts`); this is the two lines of it the page reads.
 */
const translator = (strings: Record<string, string>) => (key: string) =>
  strings[key.includes('.') ? key : `hr.${key}`] ?? (key.includes('.') ? key : `hr.${key}`)

/**
 * Markers rather than the real English sentences: an assertion naming the real string could not tell
 * a translation apart from the server's fallback, which is the whole distinction under test.
 */
const strings: Record<string, string> = { 'hr.leave_cancel_error': '[fallback]' }

/** The page's own `cancelFailure`, run, with every free name it uses handed to it. */
function failureText(
  error: unknown,
  refusals: Record<string, string> = {},
  bundle: Record<string, string> = strings,
): string {
  return new Function('t', 'cancelRefusalMessages', `${leave.fn('cancelFailure')}; return cancelFailure`)(
    translator(bundle),
    refusals,
  )(error)
}

/**
 * oRPC hands the client a `KernError` re-thrown as an `ORPCError`: an `Error` with a `code` and, for
 * a refusal, whatever the router attached — `kernErrorToORPC` carries a `reason` across as `data`.
 */
const refusal = (message: string, reason?: string) =>
  Object.assign(new Error(message), { code: 'CONFLICT', data: reason ? { reason } : undefined })

describe('a refused cancellation', () => {
  /**
   * The defect. `onError: (error) => toast.error(error.message)` put the router's English —
   * "That request is already cancelled" — in front of somebody who reads Persian and cannot act on
   * it either way.
   */
  it('translates the reason where the router sends one', () => {
    const text = failureText(
      refusal('That request is already cancelled', 'hr.leave.already_cancelled'),
      { 'hr.leave.already_cancelled': 'hr.leave_cancel_refused_gone' },
      { ...strings, 'hr.leave_cancel_refused_gone': '[translated: already cancelled]' },
    )
    expect(text).toBe('[translated: already cancelled]')
  })

  /**
   * `leave.requests.cancel` refuses through `KernError.conflict(message)` with no reason today, so
   * the router's sentence is the only thing that says *which* refusal this is. Losing it for a
   * generic string would tell the reader less than the English does.
   */
  it('falls back to the router’s sentence for a refusal with no reason of its own', () => {
    expect(failureText(refusal('That request is already cancelled'))).toBe(
      'That request is already cancelled',
    )
  })

  it('falls back to the router’s sentence for a reason no key covers yet', () => {
    expect(failureText(refusal('Something new happened', 'hr.leave.brand_new'))).toBe(
      'Something new happened',
    )
  })

  /**
   * `t()` answers a key it has no string for with the key itself, so a mapping whose translation has
   * not been merged must not put `hr.leave_cancel_refused_gone` in front of anybody.
   */
  it('never shows a message key when the mapped string has not been merged', () => {
    const text = failureText(refusal('That request is already cancelled', 'hr.leave.already_cancelled'), {
      'hr.leave.already_cancelled': 'hr.leave_cancel_refused_gone',
    })
    expect(text).toBe('That request is already cancelled')
    expect(text).not.toContain('hr.')
  })

  /**
   * A network drop, a 500 or a gateway carry machine text, in English, written for nobody — the
   * refusal is the only failure here that has a sentence meant for a reader.
   */
  it('uses this module’s own string for a failure that is not a refusal', () => {
    expect(failureText(Object.assign(new Error('Failed to fetch'), { code: 'INTERNAL' }))).toBe('[fallback]')
    expect(failureText(new TypeError('Failed to fetch'))).toBe('[fallback]')
  })

  /** A refusal with an empty sentence must still say something. */
  it('falls back to this module’s string when the refusal carries no sentence', () => {
    expect(failureText(Object.assign(new Error(''), { code: 'CONFLICT' }))).toBe('[fallback]')
  })
})
