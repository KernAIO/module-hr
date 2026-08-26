<script lang="ts">
import {
  Badge,
  Button,
  Dialog,
  DropdownMenu,
  EmptyState,
  Field,
  formatCount,
  Icon,
  IconButton,
  Input,
  type MenuItem,
  messageLocale,
  navigation,
  Page,
  PageHeader,
  SearchBox,
  SectionLabel,
  Select,
  type SelectOption,
  Skeleton,
  StatTile,
  session,
  Tabs,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { OrgUnit, Position } from '../index.js'
import { canHr } from '../permissions.js'
import { hrKeys } from '../query.js'

/**
 * The shape of the company: which departments exist, what sits under what, who heads each one, and
 * the job titles people are given.
 *
 * `hr.org.view` is a **default member permission** labelled "View the org chart, departments and
 * positions", and until this screen existed there was no org chart — every `org.*` procedure was
 * implemented, `hrKeys.orgUnits` was declared, and nothing called any of it. So this is not a
 * viewer bolted onto a working feature; it is the feature.
 *
 * **Why a drawn tree rather than an indented list.** Units are stored as `ltree`, so the hierarchy
 * is real and can be deep. Indentation alone stops being readable at about three levels — you
 * cannot tell which of the rows above a node is its parent — so every row carries the rails of its
 * ancestors and an elbow into its parent's column. That is also what makes a *subtree* legible,
 * which is the question this screen is actually asked: what is under Engineering.
 *
 * **No capability gate.** Org units and positions live under `core`, which is `required: true` —
 * there is no workspace where this is switched off, and a check against a capability that is always
 * on reads as if there were one. Every *action* is gated on `hr.org.manage`, which is the real
 * question here.
 *
 * **Positions share the screen rather than hiding in settings.** One permission covers the chart,
 * the departments and the positions; splitting the last of the three into a settings page would put
 * two thirds of a permission on one screen and leave a member who may read positions with no route
 * to them.
 */
const api = getHrApi()
const queryClient = useQueryClient()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

const canManage = $derived(canHr('orgManage'))
/**
 * The head of a department is a person, and reading a person is `hr.person.view`. Somebody granted
 * `hr.org.view` alone gets the shape of the company without the names in it — so the head is not
 * drawn as "—", which would read as "nobody heads this", but left out entirely.
 */
const canReadPeople = $derived(canHr('personView'))

type UnitRow = OrgUnit & { headcount: number }

/** `formatCount` caps at 99 for badges. A headcount is a real number and must not read "99+". */
const count = (n: number) => formatCount(n, Number.MAX_SAFE_INTEGER)

// ---------------------------------------------------------------- what is on screen
//
// Declared before the first `createQuery`, and that ordering is load-bearing rather than tidy:
// `createQuery` evaluates its options function immediately to build the observer, so an `enabled`
// reading a `$state` declared further down throws "Cannot access … before initialization" — at
// runtime, on the first render, which nothing type-checks.

interface UnitDraft {
  /** `null` while creating. The two procedures take different fields, so this decides which. */
  id: string | null
  /** Only sent on create: an existing unit is reparented through `move`, never through `update`. */
  parentId: string | null
  name: string
  code: string
  headPersonId: string
}

interface PositionDraft {
  id: string | null
  title: string
  code: string
  jobFamily: string
  level: string
}

let tab = $state('units')
let search = $state('')
let selectedId = $state<string | null>(null)
let focusedId = $state<string | null>(null)
/** Expanded is the default, so only what somebody has folded away is recorded. */
let collapsed = $state<Record<string, true>>({})

let unitDraft = $state<UnitDraft | null>(null)
let positionDraft = $state<PositionDraft | null>(null)
let movingId = $state<string | null>(null)
let moveTarget = $state('')
let archivingUnitId = $state<string | null>(null)
let archivingPositionId = $state<string | null>(null)

let formError = $state<string | null>(null)
let actionError = $state<string | null>(null)
/**
 * `disabled={save.isPending}` reaches the button one render late, and two quick clicks are one
 * render apart — which on create is two departments. Both guards are set in the same tick as the
 * click.
 */
let saving = $state(false)
let acting = $state(false)

// ---------------------------------------------------------------- queries

const unitsQuery = createQuery(() => ({
  queryKey: hrKeys.orgUnits(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.org.units.tree({ workspaceId, includeArchived: false }),
}))
const units = $derived((unitsQuery.data ?? []) as UnitRow[])

/**
 * `[module, entity, …scope]`, the shape `hrKeys` uses. Spelled here rather than in `query.ts`
 * because this screen is the only one that asks for positions, the same way the offices settings
 * page spells its own two.
 */
const positionsKey = (ws: string) => ['hr', 'positions', ws] as const

const positionsQuery = createQuery(() => ({
  queryKey: positionsKey(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.org.positions.list({ workspaceId, includeArchived: false }),
}))
const positions = $derived((positionsQuery.data ?? []) as Position[])

/**
 * The directory, for the head-of-department name and the head picker.
 *
 * Fetched whenever the chart is on screen, because the head is part of reading a department rather
 * than part of editing one — a chart that only names its heads once you open a dialog is not
 * answering "who runs this".
 */
const directoryQuery = createQuery(() => ({
  queryKey: hrKeys.people(workspaceId, { forOrg: true }),
  enabled: Boolean(workspaceId) && canReadPeople,
  queryFn: () => api.people.list({ workspaceId, limit: 200, status: ['active'] }),
}))
const directory = $derived(directoryQuery.data?.items ?? [])
const peopleById = $derived(new Map(directory.map((p) => [p.id, p.displayName])))

// ---------------------------------------------------------------- the tree

interface TreeNode {
  unit: UnitRow
  children: TreeNode[]
  /** Its own people plus everybody in every department beneath it. */
  total: number
  /** How many departments sit below it, itself excluded. */
  descendants: number
}

const byId = $derived(new Map(units.map((u) => [u.id, u])))

const forest = $derived.by((): TreeNode[] => {
  const locale = messageLocale()
  const childrenOf = new Map<string | null, UnitRow[]>()
  for (const unit of units) {
    // A unit whose parent has been archived would vanish with it, taking its own subtree off a
    // chart somebody is most likely opening in order to repair exactly that. It becomes a root
    // instead: visibly detached, but reachable and movable.
    const key = unit.parentId && byId.has(unit.parentId) ? unit.parentId : null
    const siblings = childrenOf.get(key)
    if (siblings) siblings.push(unit)
    else childrenOf.set(key, [unit])
  }
  // `path` sorts by an ltree label built from the id, so the server's order is creation order.
  // People read a department list alphabetically, and the reader's alphabet is not ours.
  const build = (parentId: string | null, ancestors: Set<string>): TreeNode[] =>
    (childrenOf.get(parentId) ?? [])
      .filter((unit) => !ancestors.has(unit.id))
      .sort((a, b) => a.name.localeCompare(b.name, locale))
      .map((unit) => {
        const children = build(unit.id, new Set(ancestors).add(unit.id))
        return {
          unit,
          children,
          total: unit.headcount + children.reduce((sum, c) => sum + c.total, 0),
          descendants: children.reduce((sum, c) => sum + c.descendants + 1, 0),
        }
      })
  return build(null, new Set())
})

const nodeById = $derived.by(() => {
  const map = new Map<string, TreeNode>()
  const walk = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      map.set(node.unit.id, node)
      walk(node.children)
    }
  }
  walk(forest)
  return map
})

const term = $derived(search.trim().toLocaleLowerCase(messageLocale()))

/**
 * The units a search leaves on screen: the ones that match, and every ancestor of a match.
 *
 * Dropping the ancestors would leave the matches floating at whatever depth they happen to be,
 * which is the one thing a tree is for. `null` means no search is running, which is not the same as
 * "nothing matched" — an empty set is.
 */
const visible = $derived.by((): Set<string> | null => {
  if (!term) return null
  const locale = messageLocale()
  const kept = new Set<string>()
  const walk = (node: TreeNode): boolean => {
    const hit =
      node.unit.name.toLocaleLowerCase(locale).includes(term) ||
      (node.unit.code ?? '').toLocaleLowerCase(locale).includes(term)
    let any = hit
    for (const child of node.children) if (walk(child)) any = true
    if (any) kept.add(node.unit.id)
    return any
  }
  for (const root of forest) walk(root)
  return kept
})

interface TreeRow {
  node: TreeNode
  depth: number
  /** One flag per ancestor column: does that ancestor have a following sibling to draw a rail for. */
  rails: boolean[]
  /** Whether this node is the last of its visible siblings, which is what ends its parent's rail. */
  last: boolean
  childCount: number
  expanded: boolean
}

const rows = $derived.by((): TreeRow[] => {
  const filter = visible
  const out: TreeRow[] = []
  const push = (nodes: TreeNode[], depth: number, rails: boolean[]) => {
    const shown = filter ? nodes.filter((n) => filter.has(n.unit.id)) : nodes
    shown.forEach((node, index) => {
      const last = index === shown.length - 1
      const kids = filter ? node.children.filter((c) => filter.has(c.unit.id)) : node.children
      // A search opens every branch it kept: hiding a match behind a fold somebody did not make is
      // the search reporting a hit it will not show.
      const expanded = kids.length > 0 && (filter !== null || !collapsed[node.unit.id])
      out.push({ node, depth, rails, last, childCount: kids.length, expanded })
      if (expanded) push(kids, depth + 1, [...rails, !last])
    })
  }
  push(forest, 0, [])
  return out
})

const selected = $derived(selectedId ? (nodeById.get(selectedId) ?? null) : null)

/**
 * Something is always selected once there is anything to select.
 *
 * An empty detail panel beside a full tree is a screen asking the reader to guess that the rows are
 * clickable, and the first root is as good an answer as any. This also re-points the panel when the
 * unit it was showing is archived or moved out from under a filter.
 */
$effect(() => {
  const known = nodeById
  if (selectedId && known.has(selectedId)) return
  selectedId = forest[0]?.unit.id ?? null
  focusedId = selectedId
})

/** The chain from the root down to `id`, the unit itself last. */
function ancestryOf(id: string): UnitRow[] {
  const chain: UnitRow[] = []
  const seen = new Set<string>()
  let cursor: UnitRow | undefined = byId.get(id)
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    chain.unshift(cursor)
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
  }
  return chain
}

/** `Engineering / Platform / Storage` — unambiguous where a bare name repeats under two parents. */
const pathLabel = (id: string): string =>
  ancestryOf(id)
    .map((u) => u.name)
    .join(' / ')

const stats = $derived({
  units: units.length,
  positions: positions.length,
  people: units.reduce((sum, u) => sum + u.headcount, 0),
  levels: units.length === 0 ? 0 : Math.max(...units.map((u) => ancestryOf(u.id).length)),
})

// ---------------------------------------------------------------- moving around the tree

function toggle(id: string) {
  if (collapsed[id]) delete collapsed[id]
  else collapsed[id] = true
}

function activate(row: TreeRow) {
  const id = row.node.unit.id
  focusedId = id
  if (row.childCount > 0 && !row.expanded) toggle(id)
  // Folding is only offered when a search is not forcing every kept branch open: writing a fold
  // nothing can show would take effect later, on a screen the person had stopped looking at.
  else if (row.childCount > 0 && visible === null && selectedId === id) toggle(id)
  selectedId = id
}

const rowDomId = (id: string) => `hr-org-${id}`

function focusRow(id: string | undefined) {
  if (!id) return
  focusedId = id
  document.getElementById(rowDomId(id))?.focus()
}

/**
 * Arrow keys, as a tree is expected to answer them.
 *
 * Right opens a closed branch and steps into an open one; left closes an open branch and steps out
 * of a leaf. That is what makes a deep chart navigable without a pointer, and it is the difference
 * between `role="tree"` being a label and being true.
 */
function onTreeKey(event: KeyboardEvent, row: TreeRow, index: number) {
  const id = row.node.unit.id
  switch (event.key) {
    case 'ArrowDown':
      focusRow(rows[index + 1]?.node.unit.id)
      break
    case 'ArrowUp':
      focusRow(rows[index - 1]?.node.unit.id)
      break
    case 'ArrowRight':
      if (row.childCount > 0 && !row.expanded) toggle(id)
      else if (row.expanded) focusRow(rows[index + 1]?.node.unit.id)
      break
    case 'ArrowLeft':
      if (row.expanded) toggle(id)
      else focusRow(rows.findLast((r, i) => i < index && r.depth < row.depth)?.node.unit.id)
      break
    case 'Home':
      focusRow(rows[0]?.node.unit.id)
      break
    case 'End':
      focusRow(rows[rows.length - 1]?.node.unit.id)
      break
    case 'Enter':
    case ' ':
      activate(row)
      break
    default:
      return
  }
  event.preventDefault()
}

// ---------------------------------------------------------------- refusals

/**
 * The org refusals this module has its own sentence for, keyed by the `reason` the router sends
 * beside the refusal — never by the sentence, because a list of sentences is a list somebody has to
 * keep in sync and the day it drifts the reader is told nothing.
 *
 * Empty today, and that is the fallback working rather than a gap: `org.units.move` refuses a cycle
 * through `KernError.badRequest` and `org.units.archive` refuses a populated department through
 * `KernError.conflict`, and neither passes a reason — so both arrive as the sentence the router
 * wrote. A reason added to either reaches the reader the moment a key lands here.
 */
const orgRefusalMessages: Record<string, string> = {}

/**
 * What a refused change says to the person who asked for it.
 *
 * The test is the transport's `code`, never the sentence. Everything else that can fail here — a
 * dropped connection, a 500, a gateway — carries machine text in English, and a confirmation dialog
 * is the last place to paste one, so only a deliberate refusal is quoted.
 *
 * The same shape as `ClockControls.svelte` and `LeavePage.svelte`; there is deliberately not a third.
 */
function refusal(error: unknown, fallbackKey: string): string {
  const failure = error as { code?: unknown; message?: string; data?: { reason?: unknown } }
  if (failure.code !== 'CONFLICT' && failure.code !== 'BAD_REQUEST') return t(fallbackKey)
  const reason = typeof failure.data?.reason === 'string' ? failure.data.reason : null
  const key = reason ? orgRefusalMessages[reason] : undefined
  // `t()` answers a key it has no string for with the key itself, so both ways of not having one —
  // a reason no key covers, and a key whose string has not been merged — land on the router's
  // sentence rather than putting `hr.org_…` in front of somebody.
  const translated = key ? t(key) : undefined
  return (translated && translated !== key ? translated : failure.message) || t(fallbackKey)
}

// ---------------------------------------------------------------- departments: create and edit

function openCreateUnit(parentId: string | null) {
  formError = null
  unitDraft = { id: null, parentId, name: '', code: '', headPersonId: '' }
}

function openEditUnit(unit: UnitRow) {
  formError = null
  unitDraft = {
    id: unit.id,
    parentId: unit.parentId,
    name: unit.name,
    code: unit.code ?? '',
    headPersonId: unit.headPersonId ?? '',
  }
}

const unitDraftValid = $derived(unitDraft !== null && unitDraft.name.trim().length > 0)

const headChoices = $derived<SelectOption[]>([
  { value: '', label: t('org_head_none') },
  ...directory.map((p) => ({ value: p.id, label: p.displayName })),
])

const parentChoices = $derived<SelectOption[]>([
  { value: '', label: t('org_root') },
  ...units
    .map((u) => ({ value: u.id, label: pathLabel(u.id) }))
    .sort((a, b) => a.label.localeCompare(b.label, messageLocale())),
])

const saveUnit = createMutation(() => ({
  mutationFn: (input: UnitDraft) =>
    input.id === null
      ? api.org.units.create({
          workspaceId,
          name: input.name.trim(),
          parentId: input.parentId,
          code: input.code.trim() || null,
          headPersonId: input.headPersonId || null,
        })
      : api.org.units.update({
          workspaceId,
          unitId: input.id,
          name: input.name.trim(),
          code: input.code.trim() || null,
          headPersonId: input.headPersonId || null,
        }),
  onSuccess: (unit, input) => {
    toast.success(input.id === null ? t('org_unit_created', { name: unit.name }) : t('org_unit_saved'))
    unitDraft = null
    formError = null
    selectedId = unit.id
    // A department decides who is in a subtree, which the directory, the approvals ladder and every
    // team view read. Invalidating the module is cheaper than guessing which.
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onError: (error: Error) => {
    formError = refusal(error, 'org_unit_save_error')
  },
  onSettled: () => {
    saving = false
  },
}))

function submitUnit() {
  if (!unitDraft || !unitDraftValid || saving) return
  saving = true
  formError = null
  saveUnit.mutate($state.snapshot(unitDraft) as UnitDraft)
}

// ---------------------------------------------------------------- departments: move

const moving = $derived(movingId ? (nodeById.get(movingId) ?? null) : null)

/**
 * Everywhere this unit could go: any department that is not itself and not underneath it, plus the
 * top level.
 *
 * The server refuses a move into a descendant — it would detach that whole branch from the root,
 * which is the one way an ltree hierarchy can be corrupted beyond repair by an ordinary drag — and
 * an option that always errors is worse than no option, so the impossible ones are not offered.
 */
const moveChoices = $derived.by((): SelectOption[] => {
  if (!moving) return []
  const forbidden = new Set<string>([moving.unit.id])
  const walk = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      forbidden.add(node.unit.id)
      walk(node.children)
    }
  }
  walk(moving.children)
  return [
    { value: '', label: t('org_root') },
    ...units
      .filter((u) => !forbidden.has(u.id))
      .map((u) => ({ value: u.id, label: pathLabel(u.id) }))
      .sort((a, b) => a.label.localeCompare(b.label, messageLocale())),
  ]
})

const moveUnchanged = $derived(moving !== null && moveTarget === (moving.unit.parentId ?? ''))

const moveUnit = createMutation(() => ({
  mutationFn: (vars: { unitId: string; parentId: string | null }) =>
    api.org.units.move({ workspaceId, unitId: vars.unitId, parentId: vars.parentId }),
  onSuccess: (_units, vars) => {
    toast.success(t('org_moved', { name: byId.get(vars.unitId)?.name ?? '' }))
    movingId = null
    actionError = null
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onError: (error: Error) => {
    actionError = refusal(error, 'org_move_error')
  },
  onSettled: () => {
    acting = false
  },
}))

function confirmMove() {
  if (!moving || acting || moveUnchanged) return
  acting = true
  actionError = null
  moveUnit.mutate({ unitId: moving.unit.id, parentId: moveTarget || null })
}

// ---------------------------------------------------------------- departments: archive

const archivingUnit = $derived(archivingUnitId ? (nodeById.get(archivingUnitId) ?? null) : null)

const archiveUnit = createMutation(() => ({
  mutationFn: (vars: { unitId: string; name: string }) =>
    api.org.units.archive({ workspaceId, unitId: vars.unitId }),
  onSuccess: (_ok, vars) => {
    toast.success(t('org_archived', { name: vars.name }))
    archivingUnitId = null
    actionError = null
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onError: (error: Error) => {
    actionError = refusal(error, 'org_archive_error')
  },
  onSettled: () => {
    acting = false
  },
}))

function confirmArchiveUnit() {
  const target = archivingUnit
  if (!target || acting) return
  acting = true
  actionError = null
  archiveUnit.mutate({ unitId: target.unit.id, name: target.unit.name })
}

/**
 * Why archiving the selected department is not offered right now, or `null` when it is.
 *
 * Two different refusals. The server checks the first — it counts current employments and refuses —
 * and saying so before the confirmation beats an error somebody only meets after deciding. The
 * second it does not check: archiving a parent leaves its children pointing at a unit that is no
 * longer in the chart, and they would surface as detached roots. That is a hole this screen closes
 * rather than one it discovers.
 */
const archiveBlocked = $derived.by((): string | null => {
  if (!selected) return null
  if (selected.children.length > 0)
    return t('org_archive_blocked_children', { count: selected.children.length })
  if (selected.unit.headcount > 0) return t('org_archive_blocked_people', { count: selected.unit.headcount })
  return null
})

// ---------------------------------------------------------------- positions

function openCreatePosition() {
  formError = null
  positionDraft = { id: null, title: '', code: '', jobFamily: '', level: '' }
}

function openEditPosition(position: Position) {
  formError = null
  positionDraft = {
    id: position.id,
    title: position.title,
    code: position.code ?? '',
    jobFamily: position.jobFamily ?? '',
    level: position.level ?? '',
  }
}

const positionDraftValid = $derived(positionDraft !== null && positionDraft.title.trim().length > 0)

const savePosition = createMutation(() => ({
  mutationFn: (input: PositionDraft) => {
    const shared = {
      workspaceId,
      title: input.title.trim(),
      code: input.code.trim() || null,
      jobFamily: input.jobFamily.trim() || null,
      level: input.level.trim() || null,
    }
    return input.id === null
      ? api.org.positions.create(shared)
      : api.org.positions.update({ ...shared, positionId: input.id })
  },
  onSuccess: (position, input) => {
    toast.success(
      input.id === null ? t('org_position_created', { title: position.title }) : t('org_position_saved'),
    )
    positionDraft = null
    formError = null
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onError: (error: Error) => {
    formError = refusal(error, 'org_position_save_error')
  },
  onSettled: () => {
    saving = false
  },
}))

function submitPosition() {
  if (!positionDraft || !positionDraftValid || saving) return
  saving = true
  formError = null
  savePosition.mutate($state.snapshot(positionDraft) as PositionDraft)
}

const archivingPosition = $derived(positions.find((p) => p.id === archivingPositionId) ?? null)

const archivePosition = createMutation(() => ({
  mutationFn: (vars: { positionId: string; title: string }) =>
    api.org.positions.archive({ workspaceId, positionId: vars.positionId }),
  onSuccess: (_ok, vars) => {
    toast.success(t('org_position_archived', { title: vars.title }))
    archivingPositionId = null
    actionError = null
    void queryClient.invalidateQueries({ queryKey: ['hr'] })
  },
  onError: (error: Error) => {
    actionError = refusal(error, 'org_position_archive_error')
  },
  onSettled: () => {
    acting = false
  },
}))

function confirmArchivePosition() {
  const target = archivingPosition
  if (!target || acting) return
  acting = true
  actionError = null
  archivePosition.mutate({ positionId: target.id, title: target.title })
}

function positionActions(position: Position): MenuItem[] {
  return [
    { label: t('common.edit'), icon: 'pencil', onSelect: () => openEditPosition(position) },
    { type: 'separator' },
    {
      label: t('common.archive'),
      icon: 'archive',
      danger: true,
      onSelect: () => {
        actionError = null
        archivingPositionId = position.id
      },
    },
  ]
}

const tabs = $derived([
  { value: 'units', label: t('org_tab_chart'), icon: 'git-branch', count: count(stats.units) },
  { value: 'positions', label: t('org_tab_positions'), icon: 'briefcase', count: count(stats.positions) },
])
</script>

<PageHeader crumbs={[{ label: workspace?.name ?? '' }, { label: t('org_title') }]} title={t('org_title')}>
  {#snippet actions()}
    {#if canManage}
      {#if tab === 'positions'}
        <Button size="sm" icon="plus" onclick={openCreatePosition}>{t('org_position_add')}</Button>
      {:else}
        <Button size="sm" icon="plus" onclick={() => openCreateUnit(null)}>{t('org_unit_add')}</Button>
      {/if}
    {/if}
  {/snippet}
</PageHeader>

<Page>
  <!--
    Tiles say what the list beneath cannot: how deep the company is, and how many people are placed
    in it at all. "Departments" repeats the tab's own count on purpose — it is the one number a
    reader looks for first, and the tab count is small enough to miss.
  -->
  {#if unitsQuery.isLoading}
    <div class="tiles">
      {#each [1, 2, 3, 4] as n (n)}<Skeleton height="86px" />{/each}
    </div>
  {:else if !unitsQuery.isError && units.length > 0}
    <div class="tiles">
      <StatTile size="md" label={t('org_stat_units')} value={count(stats.units)} />
      <StatTile size="md" label={t('org_stat_levels')} value={count(stats.levels)} />
      <StatTile size="md" label={t('org_stat_people')} value={count(stats.people)} />
      <StatTile size="md" label={t('org_stat_positions')} value={count(stats.positions)} />
    </div>
  {/if}

  <div class="tabbar">
    <Tabs items={tabs} value={tab} variant="pill" label={t('org_title')} onValueChange={(v) => (tab = v)} />
    {#if tab === 'units' && units.length > 0}
      <SearchBox
        height={32}
        width="240px"
        bind:value={search}
        label={t('org_search_label')}
        placeholder={t('org_search_placeholder')}
      />
    {/if}
  </div>

  {#if tab === 'units'}
    <!--
      Held data outranks the error. Every mutation on this screen invalidates the whole module, so a
      failed background refetch leaves the query in `error` with a perfectly good chart still in
      `data` — and an error branch placed first blanks the tree somebody is working in.
    -->
    {#if unitsQuery.isLoading}
      <div class="rows">
        {#each [1, 2, 3, 4, 5] as n (n)}<Skeleton height="40px" />{/each}
      </div>
    {:else if units.length === 0 && unitsQuery.isError}
      <EmptyState icon="triangle-alert" title={t('org_error')} description={t('org_error_desc')}>
        {#snippet actions()}
          <Button variant="secondary" onclick={() => void unitsQuery.refetch()}>{t('retry')}</Button>
        {/snippet}
      </EmptyState>
    {:else if units.length === 0}
      <EmptyState icon="git-branch" title={t('org_none')} description={t('org_none_desc')}>
        {#snippet actions()}
          {#if canManage}
            <Button icon="plus" onclick={() => openCreateUnit(null)}>{t('org_unit_add')}</Button>
          {/if}
        {/snippet}
      </EmptyState>
    {:else}
      <div class="split">
        <section class="treepane" aria-label={t('org_tab_chart')}>
          {#if rows.length === 0}
            <EmptyState compact icon="search" title={t('org_no_match')} description={t('org_no_match_desc')} />
          {:else}
            <div class="tree" role="tree" aria-label={t('org_tab_chart')}>
              {#each rows as row, index (row.node.unit.id)}
                {@const unit = row.node.unit}
                {@const head = unit.headPersonId ? peopleById.get(unit.headPersonId) : undefined}
                <div
                  id={rowDomId(unit.id)}
                  class="node"
                  class:sel={selectedId === unit.id}
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-selected={selectedId === unit.id}
                  aria-expanded={row.childCount > 0 ? row.expanded : undefined}
                  tabindex={focusedId === unit.id ? 0 : -1}
                  onclick={() => activate(row)}
                  onkeydown={(event) => onTreeKey(event, row, index)}
                >
                  {#each row.rails as rail, column (column)}
                    {#if column < row.depth - 1}
                      <span class="rail" class:on={rail} aria-hidden="true"></span>
                    {:else}
                      <span class="elbow" class:through={!row.last} aria-hidden="true"></span>
                    {/if}
                  {/each}
                  <span class="chev" class:folded={row.childCount > 0 && !row.expanded} aria-hidden="true">
                    {#if row.childCount > 0}
                      <Icon name="chevron-down" size={13} strokeWidth={1.9} />
                    {/if}
                  </span>
                  <span class="nname">{unit.name}</span>
                  {#if unit.code}<span class="code">{unit.code}</span>{/if}
                  {#if canReadPeople && head}
                    <span class="head"><Icon name="star" size={11} strokeWidth={1.8} />{head}</span>
                  {/if}
                  <span class="spacer"></span>
                  {#if row.node.total > 0}
                    <span class="pill" title={t('org_with_below')}>
                      <Icon name="users" size={11} strokeWidth={1.8} />{count(row.node.total)}
                    </span>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <aside class="detail" aria-label={t('org_detail_label')}>
          {#if selected}
            {@const unit = selected.unit}
            {@const chain = ancestryOf(unit.id)}
            {@const head = unit.headPersonId ? peopleById.get(unit.headPersonId) : undefined}
            <nav class="crumbs" aria-label={t('org_path')}>
              {#each chain.slice(0, -1) as step (step.id)}
                <button type="button" class="crumb" onclick={() => (selectedId = step.id)}>{step.name}</button>
                <span class="sep" aria-hidden="true">/</span>
              {/each}
              <span class="crumb here">{unit.name}</span>
            </nav>

            <h2 class="dtitle">
              {unit.name}
              {#if unit.code}<Badge tone="grey">{unit.code}</Badge>{/if}
            </h2>

            {#if canReadPeople}
              <div class="headrow">
                <span class="dlabel">{t('org_head')}</span>
                {#if head}
                  <span class="hname"><Icon name="star" size={12} strokeWidth={1.8} />{head}</span>
                {:else if unit.headPersonId}
                  <!-- Named on the record but not in the active directory: offboarded, or beyond
                       the page this screen reads. Saying "not set" would be a lie. -->
                  <span class="hname muted">{t('org_head_unknown')}</span>
                {:else}
                  <span class="hname muted">{t('org_head_none')}</span>
                {/if}
                {#if canManage}
                  <Button size="xs" variant="ghost" onclick={() => openEditUnit(unit)}>
                    {unit.headPersonId ? t('common.edit') : t('org_head_set')}
                  </Button>
                {/if}
              </div>
            {/if}

            <div class="metrics">
              <div class="metric">
                <span class="mv">{count(unit.headcount)}</span>
                <span class="ml">{t('org_here')}</span>
              </div>
              <div class="metric">
                <span class="mv">{count(selected.total)}</span>
                <span class="ml">{t('org_with_below')}</span>
              </div>
              <div class="metric">
                <span class="mv">{count(selected.descendants)}</span>
                <span class="ml">{t('org_subunits')}</span>
              </div>
            </div>

            {#if selected.total > 0}
              <Button
                size="sm"
                variant="secondary"
                icon="users"
                href={`/${workspaceSlug}/hr?orgUnit=${unit.id}`}
              >
                {t('org_see_people', { count: selected.total })}
              </Button>
            {/if}

            <SectionLabel sub label={t('org_subunits')} count={count(selected.children.length)} />
            {#if selected.children.length === 0}
              <p class="hint">{t('org_subunits_none')}</p>
            {:else}
              <ul class="kids">
                {#each selected.children as child (child.unit.id)}
                  <li>
                    <button type="button" class="kid" onclick={() => (selectedId = child.unit.id)}>
                      <span class="kname">{child.unit.name}</span>
                      <span class="pill">
                        <Icon name="users" size={11} strokeWidth={1.8} />{count(child.total)}
                      </span>
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}

            {#if canManage}
              <div class="acts">
                <Button size="sm" variant="secondary" icon="plus" onclick={() => openCreateUnit(unit.id)}>
                  {t('org_unit_add_child')}
                </Button>
                <Button size="sm" variant="secondary" icon="pencil" onclick={() => openEditUnit(unit)}>
                  {t('common.edit')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon="move"
                  onclick={() => {
                    actionError = null
                    moveTarget = unit.parentId ?? ''
                    movingId = unit.id
                  }}
                >
                  {t('org_move')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="archive"
                  disabled={archiveBlocked !== null}
                  onclick={() => {
                    actionError = null
                    archivingUnitId = unit.id
                  }}
                >
                  {t('common.archive')}
                </Button>
              </div>
              <!-- A disabled control with no explanation is a bug: this is the explanation. -->
              {#if archiveBlocked}<p class="hint">{archiveBlocked}</p>{/if}
            {/if}
          {:else}
            <EmptyState compact icon="git-branch" title={t('org_detail_none')} description={t('org_detail_none_desc')} />
          {/if}
        </aside>
      </div>
    {/if}
  {:else if positionsQuery.isLoading}
    <div class="rows">
      {#each [1, 2, 3] as n (n)}<Skeleton height="52px" />{/each}
    </div>
  {:else if positions.length === 0 && positionsQuery.isError}
    <EmptyState icon="triangle-alert" title={t('org_positions_error')} description={t('org_error_desc')}>
      {#snippet actions()}
        <Button variant="secondary" onclick={() => void positionsQuery.refetch()}>{t('retry')}</Button>
      {/snippet}
    </EmptyState>
  {:else if positions.length === 0}
    <EmptyState icon="briefcase" title={t('org_positions_none')} description={t('org_positions_none_desc')}>
      {#snippet actions()}
        {#if canManage}
          <Button icon="plus" onclick={openCreatePosition}>{t('org_position_add')}</Button>
        {/if}
      {/snippet}
    </EmptyState>
  {:else}
    <div class="table" role="table" aria-label={t('org_tab_positions')}>
      <div class="thead" role="row">
        <span role="columnheader">{t('org_position_title')}</span>
        <span role="columnheader">{t('org_code')}</span>
        <span role="columnheader">{t('org_position_family')}</span>
        <span role="columnheader">{t('org_position_level')}</span>
        <span class="sr-only" role="columnheader">{t('approvals_actions')}</span>
      </div>
      {#each positions as position (position.id)}
        <div class="trow" role="row">
          <span class="cell name" role="cell">{position.title}</span>
          <span class="cell mono muted" role="cell">{position.code ?? '—'}</span>
          <span class="cell muted" role="cell">{position.jobFamily ?? '—'}</span>
          <span class="cell muted" role="cell">{position.level ?? '—'}</span>
          <span class="cell end" role="cell">
            {#if canManage}
              <DropdownMenu items={positionActions(position)} align="end">
                {#snippet trigger(props)}
                  <IconButton
                    {...props}
                    icon="ellipsis"
                    size={28}
                    label={t('org_position_actions', { title: position.title })}
                  />
                {/snippet}
              </DropdownMenu>
            {/if}
          </span>
        </div>
      {/each}
    </div>
  {/if}
</Page>

<!-- ------------------------------------------------------------------ department form -->
<Dialog
  open={unitDraft !== null}
  size="sm"
  title={unitDraft?.id
    ? t('org_unit_edit_title', { name: unitDraft.name })
    : unitDraft?.parentId
      ? t('org_unit_new_under', { name: byId.get(unitDraft.parentId)?.name ?? '' })
      : t('org_unit_new')}
  onOpenChange={(open) => {
    if (!open && !saving) unitDraft = null
  }}
>
  {#if unitDraft}
    <form
      class="form"
      onsubmit={(event) => {
        event.preventDefault()
        submitUnit()
      }}
    >
      <Field label={t('display_name')} required>
        {#snippet children(id)}
          <Input {id} bind:value={unitDraft!.name} autocomplete="off" />
        {/snippet}
      </Field>
      <Field label={t('org_code')} hint={t('org_code_hint')}>
        {#snippet children(id)}
          <Input {id} mono bind:value={unitDraft!.code} autocomplete="off" />
        {/snippet}
      </Field>
      {#if unitDraft.id === null}
        <Field label={t('org_parent')}>
          {#snippet children(id)}
            <Select
              {id}
              value={unitDraft?.parentId ?? ''}
              options={parentChoices}
              placeholder={t('org_root')}
              onValueChange={(v: string) => {
                if (unitDraft) unitDraft.parentId = v || null
              }}
            />
          {/snippet}
        </Field>
      {:else}
        <!-- `org.units.update` takes no parent: reparenting rewrites the ltree path of everything
             beneath, which is `move`'s job and needs its own confirmation. -->
        <Field label={t('org_parent')} hint={t('org_parent_fixed_hint')}>
          {#snippet children(id)}
            <Input {id} readonly value={unitDraft?.parentId ? pathLabel(unitDraft.parentId) : t('org_root')} />
          {/snippet}
        </Field>
      {/if}
      {#if canReadPeople}
        <Field label={t('org_head')} hint={t('org_head_hint')}>
          {#snippet children(id)}
            <Select
              {id}
              bind:value={unitDraft!.headPersonId}
              options={headChoices}
              disabled={directoryQuery.isLoading}
              placeholder={directory.length === 0 ? t('no_people') : t('org_head_none')}
            />
          {/snippet}
        </Field>
      {/if}
      {#if formError}<p class="err" role="alert">{formError}</p>{/if}
    </form>
  {/if}

  {#snippet footer()}
    <Button variant="ghost" onclick={() => (unitDraft = null)}>{t('common.cancel')}</Button>
    <Button onclick={submitUnit} disabled={!unitDraftValid || !canManage} loading={saving}>
      {unitDraft?.id ? t('common.save') : t('org_unit_add')}
    </Button>
  {/snippet}
</Dialog>

<!-- ------------------------------------------------------------------ move -->
<Dialog
  open={moving !== null}
  size="sm"
  title={t('org_move_title', { name: moving?.unit.name ?? '' })}
  onOpenChange={(open) => {
    if (!open && !acting) movingId = null
  }}
>
  {#if moving}
    <p class="body">{t('org_move_body', { name: moving.unit.name })}</p>
    <!--
      "Everything beneath it" is an abstraction, and the whole point of confirming a move is to
      turn it into the two numbers somebody can weigh: how many departments and how many people.
      The department count includes the one being moved, so it is never zero; the people count can
      be, and zero people is its own sentence rather than a plural form reading "0 people".
    -->
    <ul class="facts">
      <li>{t('org_move_units', { count: moving.descendants + 1 })}</li>
      <li>
        {moving.total > 0 ? t('org_move_people', { count: moving.total }) : t('org_move_people_none')}
      </li>
    </ul>
    <Field label={t('org_move_to')} required>
      {#snippet children(id)}
        <Select {id} bind:value={moveTarget} options={moveChoices} placeholder={t('org_root')} />
      {/snippet}
    </Field>
    {#if moveUnchanged}<p class="hint">{t('org_move_same')}</p>{/if}
    {#if actionError}<p class="err" role="alert">{actionError}</p>{/if}
  {/if}

  {#snippet footer()}
    <Button variant="ghost" onclick={() => (movingId = null)}>{t('common.cancel')}</Button>
    <Button onclick={confirmMove} disabled={moveUnchanged || !canManage} loading={acting}>
      {t('org_move')}
    </Button>
  {/snippet}
</Dialog>

<!-- ------------------------------------------------------------------ archive a department -->
<Dialog
  open={archivingUnit !== null}
  size="sm"
  title={t('org_archive_title', { name: archivingUnit?.unit.name ?? '' })}
  onOpenChange={(open) => {
    if (!open && !acting) archivingUnitId = null
  }}
>
  <p class="body">{t('org_archive_body')}</p>
  <p class="body muted">{t('org_archive_note')}</p>
  {#if actionError}<p class="err" role="alert">{actionError}</p>{/if}

  {#snippet footer()}
    <Button variant="ghost" onclick={() => (archivingUnitId = null)}>{t('common.cancel')}</Button>
    <Button variant="danger" loading={acting} onclick={confirmArchiveUnit}>{t('common.archive')}</Button>
  {/snippet}
</Dialog>

<!-- ------------------------------------------------------------------ position form -->
<Dialog
  open={positionDraft !== null}
  size="sm"
  title={positionDraft?.id
    ? t('org_position_edit_title', { title: positionDraft.title })
    : t('org_position_new')}
  onOpenChange={(open) => {
    if (!open && !saving) positionDraft = null
  }}
>
  {#if positionDraft}
    <form
      class="form"
      onsubmit={(event) => {
        event.preventDefault()
        submitPosition()
      }}
    >
      <Field label={t('org_position_title')} required>
        {#snippet children(id)}
          <Input {id} bind:value={positionDraft!.title} autocomplete="off" />
        {/snippet}
      </Field>
      <Field label={t('org_code')} hint={t('org_code_hint')}>
        {#snippet children(id)}
          <Input {id} mono bind:value={positionDraft!.code} autocomplete="off" />
        {/snippet}
      </Field>
      <Field label={t('org_position_family')} hint={t('org_position_family_hint')}>
        {#snippet children(id)}
          <Input {id} bind:value={positionDraft!.jobFamily} autocomplete="off" />
        {/snippet}
      </Field>
      <Field label={t('org_position_level')} hint={t('org_position_level_hint')}>
        {#snippet children(id)}
          <Input {id} mono bind:value={positionDraft!.level} autocomplete="off" />
        {/snippet}
      </Field>
      {#if formError}<p class="err" role="alert">{formError}</p>{/if}
    </form>
  {/if}

  {#snippet footer()}
    <Button variant="ghost" onclick={() => (positionDraft = null)}>{t('common.cancel')}</Button>
    <Button onclick={submitPosition} disabled={!positionDraftValid || !canManage} loading={saving}>
      {positionDraft?.id ? t('common.save') : t('org_position_add')}
    </Button>
  {/snippet}
</Dialog>

<!-- ------------------------------------------------------------------ archive a position -->
<Dialog
  open={archivingPosition !== null}
  size="sm"
  title={t('org_position_archive_title', { title: archivingPosition?.title ?? '' })}
  onOpenChange={(open) => {
    if (!open && !acting) archivingPositionId = null
  }}
>
  <p class="body">{t('org_position_archive_body')}</p>
  {#if actionError}<p class="err" role="alert">{actionError}</p>{/if}

  {#snippet footer()}
    <Button variant="ghost" onclick={() => (archivingPositionId = null)}>{t('common.cancel')}</Button>
    <Button variant="danger" loading={acting} onclick={confirmArchivePosition}>{t('common.archive')}</Button>
  {/snippet}
</Dialog>

<style>
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin-block-end: 18px;
}
.rows {
  display: grid;
  gap: 4px;
}
.tabbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-block-end: 14px;
}

/* The chart and its detail. One column below 900px: a 280px panel beside a tree is two cramped
   columns rather than two useful ones. */
.split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 20px;
  align-items: start;
}
@media (max-width: 900px) {
  .split {
    grid-template-columns: minmax(0, 1fr);
  }
}

.treepane {
  min-width: 0;
  overflow-x: auto;
  /* The focus ring is drawn outside a row's box, and a scroll container clips it. */
  padding: 3px;
}
.tree {
  min-width: max-content;
}

.node {
  display: flex;
  align-items: stretch;
  gap: 0;
  min-height: 40px;
  padding-inline-end: 10px;
  border-radius: var(--kern-r-md);
  cursor: pointer;
  color: var(--kern-ink-800);
}
.node:hover {
  background: var(--kern-surface-hover);
}
.node.sel {
  background: var(--kern-accent-tint);
}
.node:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--kern-ring);
}

/*
  The rails. Each ancestor column is 18px wide and carries a vertical hairline when that ancestor
  still has a sibling below it; the last column is the elbow into this node's parent. Everything is
  positioned with `inset-inline-start`, so the whole drawing mirrors under dir="rtl" without a
  second rule.
*/
.rail,
.elbow {
  position: relative;
  inline-size: 18px;
  flex: none;
}
.rail.on::before,
.elbow::before {
  content: '';
  position: absolute;
  inset-inline-start: 9px;
  inset-block-start: 0;
  block-size: 100%;
  border-inline-start: 1px solid var(--kern-border-hairline);
}
.elbow::before {
  block-size: 50%;
}
.elbow.through::before {
  block-size: 100%;
}
.elbow::after {
  content: '';
  position: absolute;
  inset-inline-start: 9px;
  inset-block-start: 50%;
  inline-size: 9px;
  border-block-start: 1px solid var(--kern-border-hairline);
}

.chev {
  display: flex;
  align-items: center;
  justify-content: center;
  inline-size: 18px;
  flex: none;
  color: var(--kern-ink-450);
  transition: transform var(--kern-dur-fast) var(--kern-ease-out);
}
.chev.folded {
  transform: rotate(-90deg);
}
/* A closed branch points the way the language runs. */
:global([dir='rtl']) .chev.folded {
  transform: rotate(90deg);
}

.nname {
  align-self: center;
  padding-inline: 6px;
  font-size: 13.5px;
  font-weight: 500;
  white-space: nowrap;
}
.code {
  align-self: center;
  font-family: var(--kern-font-mono);
  font-size: 11.5px;
  /* A colour, not opacity: opacity fades text against the page whatever token it names. */
  color: var(--kern-ink-500);
}
.head {
  display: inline-flex;
  align-items: center;
  align-self: center;
  gap: 4px;
  margin-inline-start: 10px;
  font-size: 12px;
  color: var(--kern-ink-500);
  white-space: nowrap;
}
.spacer {
  flex: 1;
  min-inline-size: 24px;
}
.pill {
  display: inline-flex;
  align-items: center;
  align-self: center;
  gap: 4px;
  padding-inline: 7px;
  block-size: 20px;
  border-radius: var(--kern-r-full);
  background: var(--kern-surface-chip);
  font-size: 11.5px;
  color: var(--kern-ink-600);
  font-variant-numeric: tabular-nums;
}

/* ---- the detail panel ---- */
.detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-2xl);
  background: var(--kern-surface-raised);
  position: sticky;
  inset-block-start: 8px;
}
@media (max-width: 900px) {
  .detail {
    position: static;
  }
}
.crumbs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12px;
  color: var(--kern-ink-500);
}
.crumb {
  display: inline-flex;
  align-items: center;
  /* A 16px line of text is a target nobody can hit, and these sit next to each other. */
  min-block-size: 24px;
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  color: var(--kern-ink-500);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.crumb:hover {
  color: var(--kern-ink-800);
}
.crumb.here {
  color: var(--kern-ink-700);
  text-decoration: none;
}
.sep {
  color: var(--kern-ink-450);
}
.dtitle {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--kern-ink-900);
}
.headrow {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dlabel {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--kern-ink-500);
}
.hname {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  color: var(--kern-ink-800);
}
.hname.muted {
  color: var(--kern-ink-500);
}
.metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border-radius: var(--kern-r-lg);
  background: var(--kern-surface);
  border: 1px solid var(--kern-border-hairline);
}
.mv {
  font-size: 18px;
  font-weight: 600;
  line-height: 1.1;
  color: var(--kern-ink-900);
  font-variant-numeric: tabular-nums;
}
.ml {
  font-size: 11px;
  color: var(--kern-ink-500);
  text-wrap: pretty;
}
.kids {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 2px;
}
.kid {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  inline-size: 100%;
  min-block-size: 32px;
  padding-inline: 8px;
  border: 0;
  border-radius: var(--kern-r-md);
  background: none;
  font: inherit;
  color: var(--kern-ink-800);
  cursor: pointer;
  text-align: start;
}
.kid:hover {
  background: var(--kern-surface-hover);
}
.kname {
  min-inline-size: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.acts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-block-start: 4px;
  border-block-start: 1px solid var(--kern-border-hairline);
}

/* ---- positions ---- */
.table {
  --hr-position-cols: minmax(180px, 1.6fr) 110px minmax(120px, 1fr) 90px 36px;
  width: 100%;
}
.thead,
.trow {
  display: grid;
  grid-template-columns: var(--hr-position-cols);
  gap: 12px;
  align-items: center;
  padding-inline: 12px;
}
.thead {
  height: 32px;
  border-block-end: 1px solid var(--kern-border);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--kern-ink-500);
}
.trow {
  min-height: 48px;
  border-block-end: 1px solid var(--kern-border-hairline);
}
.trow:last-child {
  border-block-end: 0;
}
.trow:hover {
  background: var(--kern-surface-hover);
}
.cell {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cell.name {
  font-size: 13.5px;
  font-weight: 500;
}
.cell.muted {
  font-size: 13px;
  color: var(--kern-ink-500);
}
.cell.mono {
  font-family: var(--kern-font-mono);
  font-size: 12px;
}
.cell.end {
  display: flex;
  justify-content: flex-end;
}
@media (max-width: 760px) {
  .table {
    --hr-position-cols: minmax(140px, 1.6fr) 100px 36px;
  }
  /* Job family and level are the columns a narrow screen can lose: both are refinements of a
     title that is still on the row. */
  .thead > :nth-child(3),
  .trow > :nth-child(3),
  .thead > :nth-child(4),
  .trow > :nth-child(4) {
    display: none;
  }
}

/* ---- dialogs ---- */
.form {
  display: grid;
  gap: 14px;
}
.body {
  margin: 0 0 8px;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--kern-ink-700);
  text-wrap: pretty;
}
.body.muted {
  color: var(--kern-ink-500);
}
.facts {
  margin: 0 0 12px;
  padding-inline-start: 18px;
  display: grid;
  gap: 4px;
  font-size: 13px;
  color: var(--kern-ink-700);
}
.hint {
  margin: 0;
  font-size: 12px;
  color: var(--kern-ink-500);
  text-wrap: pretty;
}
.err {
  margin: 8px 0 0;
  font-size: 12.5px;
  color: var(--kern-danger);
}
.sr-only {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
