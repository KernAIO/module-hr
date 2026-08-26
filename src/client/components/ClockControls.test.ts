/**
 * The clock, read as data.
 *
 * This package has no component renderer — `@testing-library/svelte` and a Svelte transform are not
 * dependencies here, and adding them to reach one component is a dependency and a lockfile refresh
 * for very little (`messages.test.ts` makes the same trade for `t()`). So this parses the component
 * with the compiler that ships with Svelte and drives the three pieces of it that decide what a
 * person sees: the `{#if}` chains, the mutation's `onError`, and the map from a refusal's reason to
 * a string. All three are *the file's own source*, evaluated — not a copy of it restated here, which
 * is also true of the reason codes: those are read out of the router rather than listed again.
 *
 * What it cannot see: layout, colour and anything CSS decides. Those are checked by eye and by
 * `shell`'s `ux.spec.ts`.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'svelte/compiler'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { ar, de, en, fa, tr } from '../messages.js'
import { hrKeys } from '../query.js'

const source = readFileSync(fileURLToPath(new URL('./ClockControls.svelte', import.meta.url)), 'utf8')
const ast = parse(source, { modern: true })

interface Node {
  type: string
  start: number
  end: number
  [key: string]: unknown
}
const slice = (node: Node) => source.slice(node.start, node.end)

/** A fragment carries no offsets of its own, so its span is its first node to its last. */
function fragmentSource(fragment: { nodes: Node[] }): string {
  const nodes = fragment.nodes
  return source.slice(nodes[0]!.start, nodes[nodes.length - 1]!.end)
}

/** The top-level `{#if}…{:else if}…{:else}` chain, in the order the renderer tries it. */
function branches(): Array<{ test: string | null; body: string }> {
  const out: Array<{ test: string | null; body: string }> = []
  let block = ast.fragment.nodes.find((n) => n.type === 'IfBlock') as
    | (Node & { test: Node; consequent: { nodes: Node[] }; alternate?: { nodes: Node[] } })
    | undefined
  while (block) {
    out.push({ test: slice(block.test), body: fragmentSource(block.consequent) })
    const alternate = block.alternate
    if (!alternate) break
    const elseif = alternate.nodes.find((n) => n.type === 'IfBlock' && n.elseif)
    if (elseif) {
      block = elseif as never
      continue
    }
    out.push({ test: null, body: fragmentSource(alternate) })
    break
  }
  return out
}

interface QueryState {
  isLoading: boolean
  isError: boolean
  data?: { clockedIn: boolean; onBreak: boolean; since: string | null; workedMinutesToday: number }
}
type Scope = Record<string, unknown>

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

/** Resolve one `{#if}` chain against the scope and render whichever side it takes. */
function resolveIf(block: Node, scope: Scope): string {
  const holds = new Function(...Object.keys(scope), `return (${slice(block.test as Node)})`)(
    ...Object.values(scope),
  )
  const side = holds ? (block.consequent as { nodes: Node[] }) : (block.alternate as { nodes: Node[] } | null)
  if (!side || side.nodes.length === 0) return ''
  const nodes = side.nodes
  return resolve(nodes[0]!.start, nodes[nodes.length - 1]!.end, scope)
}

/**
 * The markup between two offsets with every `{#if}` inside it taken or dropped.
 *
 * The nested blocks are the point. Reading a branch's source *text* meant the running total and the
 * "may be stale" notice were both in it whatever the query was doing, and so were the clock-in and
 * clock-out buttons — so an assertion for a button passed against a component that never draws it.
 */
function resolve(from: number, to: number, scope: Scope): string {
  const inside = allIfBlocks().filter((b) => b.start >= from && b.end <= to)
  // Outermost first: a nested block is rendered by the recursion into the side that survives, not
  // by this loop, or it would be spliced in twice.
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

/**
 * What the renderer would draw for that query state — `clock` is `$derived(stateQuery.data)`, and
 * `since` is `$derived` from it the same way the component derives it.
 *
 * Comments are stripped: a branch that *explains* why it does not use `EmptyState` would otherwise
 * satisfy an assertion about what it renders.
 */
function rendered(stateQuery: QueryState): string {
  const clock = stateQuery.data
  const since = clock?.since
    ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(clock.since))
    : null
  const scope: Scope = { stateQuery, clock, since, punching: false }
  const top = ast.fragment.nodes.find((n) => n.type === 'IfBlock')
  if (!top) throw new Error('the markup is no longer one {#if} chain')
  return resolveIf(top as unknown as Node, scope).replace(/<!--[\s\S]*?-->/g, '')
}

const working = { clockedIn: true, onBreak: false, since: '2026-08-26T09:00:00Z', workedMinutesToday: 200 }

/** Find one property by name anywhere in the instance script, and hand back its source. */
function property(name: string): string {
  const found: Node[] = []
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    const record = node as Record<string, unknown>
    if (record.type === 'Property' && (record.key as { name?: string })?.name === name)
      found.push(record.value as Node)
    for (const value of Object.values(record)) if (value && typeof value === 'object') walk(value)
  }
  walk(ast.instance?.content)
  expect(found).toHaveLength(1)
  return slice(found[0]!)
}

/** Find one top-level `const` by name in the instance script, and hand back the whole declaration. */
function declaration(name: string): string {
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
  expect(found).toHaveLength(1)
  return `const ${name} = ${slice(found[0]!)}`
}

/** The component's own reason → message-key map, evaluated. */
function refusalMap(): Record<string, string> {
  const js = ts.transpileModule(declaration('punchRefusalMessages'), {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  }).outputText
  return new Function(`${js}; return punchRefusalMessages`)()
}

interface Recorded {
  toasts: string[]
  invalidated: unknown[][]
}

/**
 * `t()` as the runtime resolves it: this module's prefix on a bare key, and — the half that decides
 * what a refused punch says — the key itself when nothing defines a string for it. `t()` is tested
 * where it lives (`packages/ui/src/lib/i18n.test.ts`); this is the two lines of it `onError` reads.
 */
const translator = (strings: Record<string, string>) => (key: string) => {
  const full = key.includes('.') ? key : `hr.${key}`
  return strings[full] ?? full
}

/**
 * A bundle standing in for the merged one, so these tests say what a *reader* is shown rather than
 * which key was picked. The values are markers on purpose: an assertion that named the real English
 * sentence could not tell a translation apart from the server's fallback, which is the whole
 * distinction under test.
 */
const strings: Record<string, string> = {
  'hr.clock_punch_error': '[fallback]',
  'hr.clock_refused_already_in': '[translated: already clocked in]',
  'hr.clock_refused_not_in': '[translated: not clocked in]',
  'hr.clock_refused_break_needs_in': '[translated: clock in first]',
  'hr.clock_refused_already_on_break': '[translated: already on a break]',
  'hr.clock_refused_not_on_break': '[translated: not on a break]',
}

/** The real `onError`, with types stripped and every free name it uses handed to it. */
function runOnError(error: unknown, bundle: Record<string, string> = strings): Recorded {
  const js = ts.transpileModule(
    `${declaration('punchRefusalMessages')}\nconst handler = ${property('onError')}`,
    { compilerOptions: { target: ts.ScriptTarget.ESNext } },
  ).outputText
  const recorded: Recorded = { toasts: [], invalidated: [] }
  const handler = new Function('toast', 't', 'queryClient', 'hrKeys', 'workspaceId', `${js}; return handler`)(
    { error: (message: string) => recorded.toasts.push(message) },
    translator(bundle),
    { invalidateQueries: ({ queryKey }: { queryKey: unknown[] }) => recorded.invalidated.push(queryKey) },
    hrKeys,
    'ws',
  )
  handler(error)
  return recorded
}

/**
 * oRPC hands the client a `KernError` re-thrown as an `ORPCError`: an `Error` with a `code` and,
 * for a refusal, the `details` the router attached — `kernErrorToORPC` carries those across as
 * `data`.
 */
const refusal = (message: string, reason?: string) =>
  Object.assign(new Error(message), { code: 'CONFLICT', data: reason ? { reason } : undefined })

/**
 * Whether invalidating `key` re-reads `target`.
 *
 * TanStack matches by prefix, so a shorter key covers a longer one — but the empty key is not a
 * prefix anybody meant. `[]` matches every query in the app, and `[].every(…)` is true, so an
 * assertion without this guard passed against a component that invalidated nothing in particular.
 */
const covers = (key: unknown[], target: readonly unknown[]) =>
  key.length > 0 && key.length <= target.length && key.every((part, index) => part === target[index])

describe('what the clock draws', () => {
  it('derives the clock straight from the query, which is what the harness assumes', () => {
    expect(source).toContain('const clock = $derived(stateQuery.data)')
  })

  /**
   * The defect this file was written for. A poll every 60 seconds means a core restart puts the
   * query in `error` while it still holds a good clock — and an error branch that outranks the data
   * took the clock-out button off the screen of somebody mid-shift.
   */
  it('keeps the punch buttons when a background poll fails and the clock is still held', () => {
    const body = rendered({ isLoading: false, isError: true, data: working })
    expect(body).toContain("punch('out')")
    // Only the legal transitions, which is also what proves the assertion above is reading a
    // *rendered* clock rather than the source of every branch at once.
    expect(body).toContain("punch('break_start')")
    expect(body).not.toContain("punch('in')")
    expect(body).not.toContain("punch('break_end')")
  })

  it('offers the break it is in, not the one it is not', () => {
    const body = rendered({ isLoading: false, isError: false, data: { ...working, onBreak: true } })
    expect(body).toContain("punch('break_end')")
    expect(body).not.toContain("punch('break_start')")
  })

  it('offers only clocking in when the day has not started', () => {
    const body = rendered({
      isLoading: false,
      isError: false,
      data: { clockedIn: false, onBreak: false, since: null, workedMinutesToday: 0 },
    })
    expect(body).toContain("punch('in')")
    expect(body).not.toContain("punch('out')")
    expect(body).toContain("t('not_clocked_in')")
  })

  /**
   * Naming the string, not the condition: the branch body *starts* with `stateQuery.isError`, so an
   * assertion for that text held whatever the branch went on to draw — including the running total
   * it is there to replace.
   */
  it('says the held clock may be stale rather than pretending the poll succeeded', () => {
    const body = rendered({ isLoading: false, isError: true, data: working })
    expect(body).toContain("t('clock_stale')")
    expect(body).not.toContain("t('worked_today')")
  })

  it('shows the running total when the poll is succeeding', () => {
    const body = rendered({ isLoading: false, isError: false, data: working })
    expect(body).toContain("t('worked_today')")
    expect(body).not.toContain("t('clock_stale')")
  })

  it('gives the whole frame to the error only when there is nothing to show', () => {
    const body = rendered({ isLoading: false, isError: true, data: undefined })
    expect(body).toContain('retry')
    // There is no clock to punch against, so offering a punch button here would be a control that
    // cannot work. This is also what stops the assertion above passing against the clock itself.
    expect(body).not.toContain('punch(')
    // The clock widget's body is about 44px. `EmptyState` is more than twice that, so its retry
    // button sits below the fold in the one place the clock is most often read. Matching the tag
    // rather than the word: the branch's comment says why it is not used, and that is not a use.
    expect(body).not.toContain('<EmptyState')
  })

  /**
   * The last branch draws a skeleton too — for the frame before a workspace arrives — so "renders a
   * skeleton for a loading query" was true of a component with no loading branch at all. What the
   * test is named for is the *order*: loading is asked first, before anything else can answer.
   */
  it('draws a skeleton while the first fetch is in flight', () => {
    expect(branches()[0]!.test).toBe('stateQuery.isLoading')
    expect(rendered({ isLoading: true, isError: false })).toContain('Skeleton')
  })
})

describe('a refused punch', () => {
  /**
   * The defect this block was rewritten for. `punch()` writes its refusals for a person — "You are
   * not clocked in." — and the widget used to repeat them verbatim, so a Persian, Arabic, Turkish or
   * German reader met English at the one moment they needed the explanation. The router now sends a
   * reason beside the sentence, and the reason is what this file translates.
   */
  it('translates the reason the server sent rather than repeating its English', () => {
    const { toasts } = runOnError(refusal('You are not clocked in.', 'hr.clock.not_clocked_in'))
    expect(toasts).toEqual(['[translated: not clocked in]'])
  })

  it('translates every reason the router can refuse a punch with', () => {
    for (const [reason, key] of Object.entries(refusalMap())) {
      expect({ reason, toasts: runOnError(refusal('English sentence.', reason)).toasts }).toEqual({
        reason,
        toasts: [strings[key]],
      })
    }
  })

  /**
   * The fallback, and why it stays: a sixth refusal added to `punch()` reaches the reader in the
   * router's English rather than not at all, without anyone editing this file first.
   */
  it('shows the server’s sentence for a reason it has no string for', () => {
    const { toasts } = runOnError(refusal('You are barred from the building.', 'hr.clock.barred'))
    expect(toasts).toEqual(['You are barred from the building.'])
  })

  /**
   * The same fallback one step further in: the reason is known and the *string* is not, which is
   * what a locale merged half-way looks like. `t()` answers a key it cannot resolve with the key,
   * so without this the toast reads `hr.clock_refused_not_in`.
   */
  it('shows the server’s sentence rather than a message key nobody merged', () => {
    const { toasts } = runOnError(refusal('You are not clocked in.', 'hr.clock.not_clocked_in'), {
      'hr.clock_punch_error': '[fallback]',
    })
    expect(toasts).toEqual(['You are not clocked in.'])
  })

  /** An older server, or a refusal from anywhere else on this path: still a sentence, still shown. */
  it('shows the server’s sentence for a refusal that carries no reason at all', () => {
    expect(runOnError(refusal('You are not clocked in.')).toasts).toEqual(['You are not clocked in.'])
  })

  /**
   * Everything that is not a refusal. A network drop, a 500 and a gateway all carry machine text in
   * English, and a clock is the last place to paste one — so the reason is never read off them, and
   * a `CONFLICT` is never assumed from the sentence.
   */
  it('falls back to the module’s own string for a failure nobody wrote for a reader', () => {
    expect(runOnError(new Error('Failed to fetch')).toasts).toEqual(['[fallback]'])
  })

  it('ignores a reason on anything that is not a refusal', () => {
    const notRefused = Object.assign(new Error('upstream connect error'), {
      code: 'INTERNAL',
      data: { reason: 'hr.clock.not_clocked_in' },
    })
    expect(runOnError(notRefused).toasts).toEqual(['[fallback]'])
  })

  /**
   * The commonest reason a punch is refused is that the clock on screen is stale — the auto
   * clock-out sweep closed the shift, or a punch arrived from another device. Leaving the same wrong
   * clock up means every retry earns the same toast and nothing ever corrects it.
   */
  it('re-reads the clock and the day sheet, because the refusal means what is on screen is wrong', () => {
    const { invalidated } = runOnError(refusal('You are already clocked in.', 'hr.clock.already_clocked_in'))
    expect(invalidated.some((key) => covers(key, hrKeys.clockState('ws')))).toBe(true)
    expect(invalidated.some((key) => covers(key, hrKeys.attendanceDays('ws', undefined, 'a', 'b')))).toBe(
      true,
    )
  })
})

/**
 * The wire between the two halves of this package.
 *
 * A reason code is API: the router writes it, this component reads it, and nothing in between would
 * notice them drifting apart — the widget would quietly go back to English, which is the defect
 * this whole change exists to remove. So the check reads the router's own source, rather than a
 * list of reasons restated here that could go stale with it.
 *
 * It is deliberately one-directional. A reason the router sends and this file does not know is the
 * fallback working as designed; a reason this file translates and the router never sends is a
 * rename nobody noticed.
 */
describe('the reasons the router sends', () => {
  const router = readFileSync(fileURLToPath(new URL('../../server/router.ts', import.meta.url)), 'utf8')

  /** The five guards inside `punch()`, from its refusal comment to the punch it goes on to record. */
  function punchGuards(): string {
    const from = router.indexOf('// Refuse the transitions that make no sense')
    const to = router.indexOf('const punchRow = await attendance.record(', from)
    if (from < 0 || to < 0) throw new Error('punch() no longer has the shape this check reads')
    return router.slice(from, to)
  }

  it('sends a reason with every refusal a punch can earn', () => {
    const guards = punchGuards()
    // A refusal built any other way carries no `details`, so nothing reaches `data.reason` and the
    // reader gets English. `KernError.conflict`'s own `reason` argument is one of those ways: it is
    // kept on the error object and never serialised.
    expect(guards).not.toContain('KernError.conflict(')
    expect(guards.match(/refusePunch\(/g)).toHaveLength(5)
  })

  it('still sends every reason this component translates', () => {
    const sent = new Set([...punchGuards().matchAll(/refusePunch\('([^']+)'/g)].map((m) => m[1]!))
    for (const reason of Object.keys(refusalMap()))
      expect({ reason, sent: sent.has(reason) }).toEqual({ reason, sent: true })
  })
})

/**
 * The strings those keys name. `t()` renders a key it cannot resolve as itself, and `onError`
 * catches that at runtime by falling back to the server's English — but a locale that never got the
 * string is a defect, not a fallback, and nothing else in this package looks at a key's *use*.
 */
describe('the strings those reasons name', () => {
  it('has a string in every locale for every reason the component translates', () => {
    for (const key of Object.values(refusalMap()))
      for (const [locale, bundle] of Object.entries({ en, ar, de, fa, tr }))
        expect({ locale, key, present: key in bundle }).toEqual({ locale, key, present: true })
  })
})
