<script lang="ts">
import {
  Badge,
  Button,
  Dialog,
  DropdownMenu,
  EmptyState,
  Field,
  formatCount,
  formatDate,
  formatDateRange,
  IconButton,
  Input,
  type MenuItem,
  messageLocale,
  navigation,
  SectionLabel,
  Select,
  SettingsPage,
  SettingsSection,
  Skeleton,
  StatTile,
  Switch,
  session,
  toast,
} from '@kernhq/ui'
import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query'
// Straight from the contract rather than through the client barrel: policies were never one of the
// models the barrel re-exports, and widening it is a shared file three other screens are editing.
// `AccrualConfig` is imported as a value on purpose — see `configOf`.
import {
  AccrualConfig,
  CarryForwardConfig,
  type Policy,
  type PolicyAssignment,
  type PolicyKind,
  type PolicySubjectKind,
  SUBJECT_PRIORITY,
} from '../../contract/policies.js'
import { getHrApi } from '../api-instance.js'
import { HR_CAPABILITIES } from '../capabilities.js'
import { t } from '../i18n.js'
import { canHr } from '../permissions.js'
import { formatDays, formatDuration, hrKeys, isoDate, monthRange } from '../query.js'

/**
 * How leave is earned over time.
 *
 * Switching `leave_accrual` on used to start an hourly job and give nobody a way to look at it: the
 * policies existed, the ladder existed, the preview existed, and none of the three had a caller. So
 * four things justify this screen, and everything on it serves one of them.
 *
 * **A policy is data, and the data has to say when leave appears.** All four frequencies are
 * implemented and each answers a different question — a twelfth every month, the whole year on one
 * date, a year on each anniversary, or a share scaled by hours actually worked. Naming them is not
 * enough; the form says what the one you picked will do, because "anniversary" and "annual" sound
 * alike and credit on entirely different days.
 *
 * **The ladder is the module's load-bearing abstraction, and this is where somebody sees it.**
 * Person → office → legal entity → org unit → position → workspace, nearest wins. The rungs are
 * drawn in that order with every accrual assignment in the workspace on them, rather than one
 * policy's assignments at a time: "which policy applies to her" is answered by what is *nearest*,
 * so a view that hides the other policies hides the answer. The order comes from the contract's own
 * `SUBJECT_PRIORITY` rather than being retyped here.
 *
 * **Nothing reaches the ledger unpreviewed.** `accrual.preview` runs the same code the run does, so
 * the run button lives inside the preview dialog and is disabled until there are numbers on screen.
 * A credit cannot be undone from here — it is corrected with a leave adjustment — which is exactly
 * why an admin gets to read it first.
 *
 * **What is earned has to survive the turn of the year, and that is a second policy.** The engine
 * has always carried a capped balance forward and expired the rest — `carryForward`, the
 * `carry-forward` job, and `carry_in` / `carry_out` / `expiry` in the ledger — but a
 * `carry_forward` policy could not be written from anywhere, so the capability card promised
 * carry-forward and expiry and an admin could reach neither. Both kinds are `policies` rows on one
 * ladder, resolved independently of each other, so they share this screen's assign dialog and are
 * told apart by a badge rather than by two ladders that would each hide half the answer.
 */
const api = getHrApi()
const queryClient = useQueryClient()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

/**
 * The page is contributed under `hr.policy.manage`, so this is normally true — it is read anyway
 * because a settings URL can be typed, and a screen full of live buttons the server will refuse is
 * worse than a screen that says so.
 */
const manage = $derived(canHr('policyManage'))

/** Which rungs can be *named*: two of them are behind their own capability and their own read. */
const hasOffices = $derived(session.hasCapability('hr', HR_CAPABILITIES.offices) && canHr('officeView'))
const hasEntities = $derived(
  session.hasCapability('hr', HR_CAPABILITIES.legalEntities) && canHr('entityView'),
)
const hasOrg = $derived(canHr('orgView'))
const hasPeople = $derived(canHr('personView'))
/** `per_hour_worked` reads attendance day sheets; without them it accrues nothing at all. */
const hasAttendance = $derived(session.hasCapability('hr', HR_CAPABILITIES.attendance))

type PolicyRow = Policy & { assignments: PolicyAssignment[] }
type Frequency = AccrualConfig['frequency']
type Tier = { afterYears: string; daysPerYear: string }

const FREQUENCIES: Frequency[] = ['monthly', 'annual', 'anniversary', 'per_hour_worked']

const freqLabel = (frequency: Frequency): string =>
  frequency === 'monthly'
    ? t('accr_freq_monthly')
    : frequency === 'annual'
      ? t('accr_freq_annual')
      : frequency === 'anniversary'
        ? t('accr_freq_anniversary')
        : t('accr_freq_per_hour')

/**
 * Which of the two kinds a row is.
 *
 * Only `accrual` and `carry_forward` ever reach this screen: both queries below name their kind, so
 * nothing else is ever in the arrays this labels. A third kind shown here would read as "Accrual"
 * and would have to be given its own branch on the way in.
 */
const kindLabel = (kind: PolicyKind): string =>
  kind === 'carry_forward' ? t('policy_kind_carry_forward') : t('policy_kind_accrual')

/** What the frequency actually does. Copied from `grantForPeriod`, which is what performs it. */
const freqDesc = (frequency: Frequency): string =>
  frequency === 'monthly'
    ? t('accr_freq_monthly_desc')
    : frequency === 'annual'
      ? t('accr_freq_annual_desc')
      : frequency === 'anniversary'
        ? t('accr_freq_anniversary_desc')
        : t('accr_freq_per_hour_desc')

/**
 * The ladder, ordered by the contract's own numbers.
 *
 * Written out, the sequence would be a second place to keep it — and the day the two disagree the
 * screen draws a precedence the resolver does not use, which is the one thing this page exists to
 * make honest.
 */
const LADDER: PolicySubjectKind[] = (Object.keys(SUBJECT_PRIORITY) as PolicySubjectKind[]).sort(
  (a, b) => SUBJECT_PRIORITY[b] - SUBJECT_PRIORITY[a],
)

const rungLabel = (kind: PolicySubjectKind): string =>
  kind === 'person'
    ? t('accr_rung_person')
    : kind === 'office'
      ? t('accr_rung_office')
      : kind === 'legal_entity'
        ? t('accr_rung_legal_entity')
        : kind === 'org_unit'
          ? t('accr_rung_org_unit')
          : kind === 'position'
            ? t('accr_rung_position')
            : t('accr_rung_workspace')

const rungHint = (kind: PolicySubjectKind): string =>
  kind === 'person'
    ? t('accr_rung_person_hint')
    : kind === 'office'
      ? t('accr_rung_office_hint')
      : kind === 'legal_entity'
        ? t('accr_rung_legal_entity_hint')
        : kind === 'org_unit'
          ? t('accr_rung_org_unit_hint')
          : kind === 'position'
            ? t('accr_rung_position_hint')
            : t('accr_rung_workspace_hint')

const durationWords = {
  hours: (n: string) => t('hours_short', { n }),
  minutes: (n: string) => t('minutes_short', { n }),
}
const duration = (minutes: number) => formatDuration(minutes, durationWords, messageLocale())
const days = (n: number) => formatDays(n, messageLocale())

// ---------------------------------------------------------------- the policies

let showArchived = $state(false)

const policiesQuery = createQuery(() => ({
  queryKey: ['hr', 'policies', workspaceId, 'accrual', showArchived] as const,
  enabled: Boolean(workspaceId),
  queryFn: () => api.policies.list({ workspaceId, kind: 'accrual', includeArchived: showArchived }),
}))
const policies = $derived((policiesQuery.data ?? []) as PolicyRow[])

/**
 * A disabled query is `pending` and not fetching, so it is not loading — without the workspace test
 * the first frame offers "no policies yet" to a workspace that has six.
 */
const policiesLoading = $derived(!workspaceId || policiesQuery.isLoading)

/**
 * The config, parsed rather than cast.
 *
 * `config` is a `jsonb` record on the wire, and the schema is the only thing that knows which keys
 * belong to an accrual policy. A row the server wrote is valid by construction — but a row written
 * by an older release, or by hand, is not, and a cast would render `undefined d/yr` instead of
 * saying the row cannot be read.
 */
function configOf(policy: PolicyRow): AccrualConfig | null {
  const parsed = AccrualConfig.safeParse(policy.config)
  return parsed.success ? parsed.data : null
}

// ---------------------------------------------------------------- carry-forward

/**
 * The other kind of policy on this screen, asked for separately.
 *
 * One list per kind rather than one call filtered here: `policies.list` takes the kind, the two
 * lists are drawn in two sections, and a single query would make the accrual tiles count
 * carry-forward rows. `showArchived` is shared, because it is one control at the top of the page.
 */
const carryQuery = createQuery(() => ({
  queryKey: ['hr', 'policies', workspaceId, 'carry_forward', showArchived] as const,
  enabled: Boolean(workspaceId),
  queryFn: () => api.policies.list({ workspaceId, kind: 'carry_forward', includeArchived: showArchived }),
}))
const carryPolicies = $derived((carryQuery.data ?? []) as PolicyRow[])
const carryLoading = $derived(!workspaceId || carryQuery.isLoading)

/** Same reason as `configOf`: the stored jsonb is only a carry-forward config if it parses as one. */
function carryConfigOf(policy: PolicyRow): CarryForwardConfig | null {
  const parsed = CarryForwardConfig.safeParse(policy.config)
  return parsed.success ? parsed.data : null
}

/**
 * A failed refetch that still has an answer, on either list.
 *
 * Every write here invalidates the whole module, so a refetch failing while the last good lists are
 * on screen is the ordinary case — an error branch above the data would blank a working page. One
 * banner for both, because a reader is being told the page is behind, not which query said so.
 */
const stale = $derived(
  (policiesQuery.isError && policies.length > 0) || (carryQuery.isError && carryPolicies.length > 0),
)

const leaveTypesQuery = createQuery(() => ({
  queryKey: hrKeys.leaveTypes(workspaceId),
  enabled: Boolean(workspaceId) && canHr('leaveView'),
  queryFn: () => api.leave.types.list({ workspaceId, includeArchived: false }),
}))
const leaveTypes = $derived(leaveTypesQuery.data ?? [])
const leaveTypeName = (key: string): string => leaveTypes.find((type) => type.key === key)?.name ?? key

const liveAssignments = $derived(policies.filter((p) => !p.archivedAt).flatMap((p) => p.assignments))

/**
 * The rung everybody with nothing nearer falls to, per kind. Its absence is the interesting case,
 * and it is a different question for each kind: a workspace can accrue without carrying anything
 * over, and the two gaps are said in two different places rather than in one sentence about
 * "policies" that would be half wrong whichever kind was missing.
 */
const defaultOn = (rows: PolicyRow[]) =>
  rows.find((p) => !p.archivedAt && p.assignments.some((a) => a.subjectKind === 'workspace')) ?? null
const workspaceDefault = $derived(defaultOn(policies))
const carryDefault = $derived(defaultOn(carryPolicies))

const livePolicies = $derived(policies.filter((policy) => !policy.archivedAt))
const liveCarry = $derived(carryPolicies.filter((policy) => !policy.archivedAt))
/**
 * Both kinds on one ladder.
 *
 * They are resolved independently — a person can be answered by their office's accrual policy and
 * the workspace's carry-forward policy at once — so this is not a list of rivals. It is drawn as
 * one ladder because the *rungs* are the same six and the precedence is the same rule, and two
 * ladders side by side would each hide half of what applies to somebody.
 */
const ladderPolicies = $derived([...livePolicies, ...liveCarry])
const ladderAssignments = $derived(ladderPolicies.flatMap((policy) => policy.assignments))

/**
 * A policy change moves leave balances, the accrual preview and every resolution beneath it, so the
 * module's cache is dropped whole rather than guessing which keys a recomputation touched.
 */
const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: ['hr'] })
}

/**
 * One click, one write.
 *
 * `disabled={mutation.isPending}` reaches the button on the next render and two quick clicks are one
 * render apart — which on this screen means two policies, two assignments, or an accrual run fired
 * twice. The flag is set in the same tick as the click and cleared when the call settles.
 */
let firing = $state(false)
function once(run: () => void) {
  if (firing) return
  firing = true
  run()
}
const settled = () => {
  firing = false
}

/**
 * The refusals this module has its own sentence for, keyed by the `reason` the router sends beside
 * the refusal — never by the sentence, because a list of sentences is a list somebody has to keep
 * in sync and the day it drifts the reader is told nothing.
 *
 * Empty on purpose. The policy router refuses a bad config through `KernError.badRequest` with an
 * `issues` list rather than a reason, and that list is the only thing that says *which* field the
 * server disagreed with — so it is what `failureText` shows. A reason added to the router later
 * gets its string here without touching a call site.
 */
const policyRefusalMessages: Record<string, string> = {}

/**
 * What a refused write says.
 *
 * Same shape as `LeavePage.svelte` and `ClockControls.svelte`: a machine-readable `reason` first,
 * then the server's own words. `t()` answers a key it has no string for with the key itself, so a
 * reason no key covers falls through to the router's sentence rather than putting `hr.accr_…` in
 * front of somebody.
 */
function failureText(error: unknown, fallbackKey: string): string {
  const failure = error as {
    message?: string
    data?: { reason?: unknown; issues?: unknown }
  }
  const reason = typeof failure.data?.reason === 'string' ? failure.data.reason : null
  const key = reason ? policyRefusalMessages[reason] : undefined
  const translated = key ? t(key) : undefined
  if (translated && translated !== key) return translated
  const issues = failure.data?.issues
  if (Array.isArray(issues) && issues.length > 0) return issues.map(String).join(' · ')
  return failure.message || t(fallbackKey)
}

// ---------------------------------------------------------------- the policy form

/**
 * What an empty form starts a day at, and the only eight hours on this screen.
 *
 * A seed, never a conversion. `accrueForPeriod` multiplies entitlement days by the policy's own
 * `minutesPerDay`, so anything here that turns time into days — or days into time — reads that
 * figure instead of assuming one: five days of a seven-and-a-half-hour day is 2250 minutes, and at
 * a hardcoded 8 × 60 the same five days read as 2400, which is a cap that never bites and a
 * balance nobody can reconcile against the ledger.
 */
const DEFAULT_DAY_MINUTES = 8 * 60
/** The contract's own ceiling on `roundToMinutes`. A whole day exceeds it on any day past eight hours. */
const ROUND_CAP_MINUTES = 480

let policyDialog = $state<'create' | 'edit' | null>(null)
let policyId = $state('')
let policyName = $state('')
let policyFrom = $state(isoDate())
let policyTo = $state('')
let frequency = $state<Frequency>('monthly')
let leaveTypeKey = $state('')
let daysPerYear = $state('20')
let minutesPerDay = $state(String(DEFAULT_DAY_MINUTES))
let waitingMonths = $state('0')
/** A token rather than a minute count — see `roundMinutes`. */
let roundChoice = $state('0')
let tiers = $state<Tier[]>([])
/**
 * Carried through the form rather than shown in it.
 *
 * `AccrualConfig.calendar` decides where a period boundary falls — Iran accrues on Jalali months —
 * and nothing on this screen sets it yet. Omitting it from the draft is not neutral: the schema
 * defaults it, so saving a name change on a Persian-calendar policy would silently move it to
 * Gregorian. It is read back and written out untouched until there is a control for it.
 */
let policyCalendar = $state<AccrualConfig['calendar']>('gregorian')
let policyError = $state<string | null>(null)
/**
 * Whether the form was seeded from a config the schema could not read.
 *
 * `configOf` answering null means the stored jsonb is not an accrual config — an older release, or
 * a row edited by hand. Every field below then holds a default, and saving writes those defaults
 * over whatever the engine is actually using, so the dialog says so rather than presenting eight
 * hours and twenty days as though they were the policy.
 */
let seededFromUnreadable = $state(false)

function openCreate() {
  policyDialog = 'create'
  policyId = ''
  policyName = ''
  policyFrom = `${new Date().getFullYear()}-01-01`
  policyTo = ''
  frequency = 'monthly'
  leaveTypeKey = leaveTypes[0]?.key ?? ''
  daysPerYear = '20'
  minutesPerDay = String(DEFAULT_DAY_MINUTES)
  waitingMonths = '0'
  roundChoice = '0'
  tiers = []
  policyCalendar = 'gregorian'
  policyError = null
  seededFromUnreadable = false
}

function fillFrom(policy: PolicyRow) {
  const config = configOf(policy)
  seededFromUnreadable = config === null
  policyName = policy.name
  policyTo = policy.effectiveTo ?? ''
  frequency = config?.frequency ?? 'monthly'
  leaveTypeKey = config?.leaveTypeKey ?? leaveTypes[0]?.key ?? ''
  daysPerYear = String(config?.daysPerYear ?? 20)
  const day = config?.minutesPerDay ?? DEFAULT_DAY_MINUTES
  minutesPerDay = String(day)
  waitingMonths = String(config?.waitingPeriodMonths ?? 0)
  // Back to what the step *meant* under the day it was saved with. Read as a bare number, a policy
  // rounding to a whole 450-minute day would reopen as "450 minutes" and stop following the day the
  // moment somebody lengthened it.
  const step = config?.roundToMinutes ?? 0
  roundChoice = step === 0 ? '0' : step === day ? 'day' : step === Math.round(day / 2) ? 'half' : String(step)
  tiers = (config?.seniorityTiers ?? []).map((tier) => ({
    afterYears: String(tier.afterYears),
    daysPerYear: String(tier.daysPerYear),
  }))
  policyCalendar = config?.calendar ?? 'gregorian'
  policyError = null
}

function openEdit(policy: PolicyRow) {
  policyDialog = 'edit'
  policyId = policy.id
  policyFrom = policy.effectiveFrom
  fillFrom(policy)
}

/**
 * The affordance behind the rule the contract states: a change that should apply from a date is a
 * *new* policy with a later `effectiveFrom`, not an edit. Saying that in the edit dialog and then
 * making somebody retype eleven fields is how the rule gets ignored.
 */
function openDuplicate(policy: PolicyRow) {
  policyDialog = 'create'
  policyId = ''
  fillFrom(policy)
  policyName = t('accr_copy_of', { name: policy.name })
  policyFrom = isoDate()
  policyTo = ''
}

const clamped = (value: string, min: number, max: number) =>
  Math.min(Math.max(Math.round(Number(value) || 0), min), max)
const clampedDays = (value: string, min: number, max: number) => {
  const parsed = Math.round((Number(value) || 0) * 100) / 100
  return Math.min(Math.max(parsed, min), max)
}

/**
 * The day this policy is being given, and the figure everything below converts against.
 *
 * The same number the server stores as `minutesPerDay` and `accrueForPeriod` multiplies by, so a
 * length shown here is the length leave is actually earned in.
 */
const dayMinutes = $derived(clamped(minutesPerDay, 1, 1440))

/**
 * Rounding held as what the admin meant, resolved against the day beside it.
 *
 * "A whole day" is 450 minutes on a seven-and-a-half-hour day and 480 on an eight-hour one. Held as
 * a bare number the step stops meaning a day the moment the day length changes — silently, because
 * the select goes on reading "A whole day" while the engine rounds to something else. So the choice
 * is a token and the minutes follow from it.
 */
const roundMinutes = $derived(
  roundChoice === 'day'
    ? dayMinutes
    : roundChoice === 'half'
      ? Math.round(dayMinutes / 2)
      : Math.max(0, Math.round(Number(roundChoice) || 0)),
)

/**
 * Rounding offered as the steps somebody actually means, half and whole days included.
 *
 * The two day steps are kept beside the fixed ones even where they land on the same number, because
 * they are a different choice: one follows the day length, the other stays where it was typed. A
 * whole day past the contract's cap is offered and refused by `formProblem` with the reason next to
 * the button, rather than dropped from the list with nothing to explain the gap.
 */
const roundOptions = $derived.by(() => {
  const half = Math.round(dayMinutes / 2)
  const options = [
    { value: '0', minutes: 0, label: t('accr_round_exact') },
    { value: '15', minutes: 15, label: t('accr_round_minutes', { count: 15 }) },
    { value: '30', minutes: 30, label: t('accr_round_minutes', { count: 30 }) },
    { value: '60', minutes: 60, label: t('accr_round_minutes', { count: 60 }) },
    { value: 'half', minutes: half, label: t('accr_round_half_day', { length: duration(half) }) },
    { value: 'day', minutes: dayMinutes, label: t('accr_round_day', { length: duration(dayMinutes) }) },
  ]
  // A stored step none of these produce would otherwise vanish the moment somebody opened the
  // policy to change its name.
  if (!options.some((option) => option.value === roundChoice))
    options.push({
      value: roundChoice,
      minutes: roundMinutes,
      label: t('accr_round_minutes', { count: roundMinutes }),
    })
  return options.sort((a, b) => a.minutes - b.minutes).map(({ value, label }) => ({ value, label }))
})

const tierYears = $derived(tiers.map((tier) => clamped(tier.afterYears, 0, 60)))
const tiersClash = $derived(new Set(tierYears).size !== tierYears.length)

const formProblem = $derived.by(() => {
  if (!policyName.trim()) return t('accr_error_name')
  if (!leaveTypeKey) return t('accr_error_leave_type')
  if (!policyFrom) return t('accr_error_from')
  if (policyTo && policyTo < policyFrom) return t('accr_error_to_before_from')
  if (tiersClash) return t('accr_error_tier_clash')
  // Said rather than clamped: a step quietly cut back to eight hours is a policy rounding to
  // something other than the day it names.
  if (roundMinutes > ROUND_CAP_MINUTES) return t('accr_error_round_cap', { max: duration(ROUND_CAP_MINUTES) })
  return null
})

const configDraft = $derived({
  frequency,
  daysPerYear: clampedDays(daysPerYear, 0, 365),
  minutesPerDay: dayMinutes,
  seniorityTiers: tiers.map((tier) => ({
    afterYears: clamped(tier.afterYears, 0, 60),
    daysPerYear: clampedDays(tier.daysPerYear, 0, 365),
  })),
  waitingPeriodMonths: clamped(waitingMonths, 0, 24),
  // Save is blocked above the cap, so this never silently shortens a step somebody chose.
  roundToMinutes: Math.min(roundMinutes, ROUND_CAP_MINUTES),
  calendar: policyCalendar,
  leaveTypeKey,
})

const savePolicy = createMutation(() => ({
  mutationFn: () =>
    policyDialog === 'edit'
      ? api.policies.update({
          workspaceId,
          policyId,
          name: policyName.trim(),
          // `$state.snapshot` because the tiers are a state proxy, and a proxy cannot be cloned on
          // its way into the request — the call throws instead of saving.
          config: $state.snapshot(configDraft),
          effectiveTo: policyTo || null,
        })
      : api.policies.create({
          workspaceId,
          kind: 'accrual',
          name: policyName.trim(),
          config: $state.snapshot(configDraft),
          effectiveFrom: policyFrom,
          effectiveTo: policyTo || null,
        }),
  onSuccess: (policy: Policy) => {
    toast.success(policyDialog === 'edit' ? t('accr_saved') : t('accr_created', { name: policy.name }))
    policyDialog = null
    policyError = null
    refresh()
  },
  onError: (error: Error) => {
    policyError = failureText(error, 'accr_save_error')
  },
  onSettled: settled,
}))

let archiving = $state<PolicyRow | null>(null)

const archivePolicy = createMutation(() => ({
  mutationFn: (policy: PolicyRow) => api.policies.archive({ workspaceId, policyId: policy.id }),
  onSuccess: (_ok, policy: PolicyRow) => {
    toast.success(t('accr_archived', { name: policy.name }))
    archiving = null
    refresh()
  },
  onError: (error: Error) => toast.error(failureText(error, 'accr_archive_error')),
  onSettled: settled,
}))

function policyMenu(policy: PolicyRow): MenuItem[] {
  return [
    { label: t('common.edit'), icon: 'square-pen', onSelect: () => openEdit(policy) },
    { label: t('accr_duplicate'), icon: 'copy', onSelect: () => openDuplicate(policy) },
    {
      label: t('accr_assign'),
      icon: 'user-plus',
      onSelect: () => openAssign(policy.id),
    },
    { type: 'separator' },
    {
      label: t('common.archive'),
      icon: 'archive',
      danger: true,
      disabled: Boolean(policy.archivedAt),
      hint: policy.archivedAt ? t('accr_already_archived') : undefined,
      onSelect: () => {
        archiving = policy
      },
    },
  ]
}

// ---------------------------------------------------------------- the carry-forward form

/**
 * What survives the turn of the year, and how long there is to use it.
 *
 * Three fields, and each of them is something the engine already reads: `maxDays` is the cap
 * `carryForward` clips the closing balance to, `expiresAfterMonths` is what `carryExpiryDate`
 * counts from 1 January, and `leaveTypeKey` is the balance both apply to. Nothing here is invented
 * — a fourth field would be a setting nothing obeys, which is the defect this screen exists to
 * repair rather than repeat.
 *
 * The deadline is held as a switch and a number rather than as a nullable number, because "never"
 * and "one month" are the two answers an admin actually has and a blank box does not say which of
 * them it means.
 */
let carryDialog = $state<'create' | 'edit' | null>(null)
let carryId = $state('')
let carryName = $state('')
let carryTypeKey = $state('')
let carryMaxDays = $state('5')
let carryExpires = $state(false)
let carryMonths = $state('3')
let carryFrom = $state(isoDate())
let carryTo = $state('')
let carryError = $state<string | null>(null)
/** Same trap as `seededFromUnreadable`, for the other schema. */
let carrySeededFromUnreadable = $state(false)

function openCarryCreate() {
  carryDialog = 'create'
  carryId = ''
  carryName = ''
  carryTypeKey = leaveTypes[0]?.key ?? ''
  carryMaxDays = '5'
  carryExpires = false
  carryMonths = '3'
  carryFrom = `${new Date().getFullYear()}-01-01`
  carryTo = ''
  carryError = null
  carrySeededFromUnreadable = false
}

function fillCarryFrom(policy: PolicyRow) {
  const config = carryConfigOf(policy)
  carrySeededFromUnreadable = config === null
  carryName = policy.name
  carryTo = policy.effectiveTo ?? ''
  carryTypeKey = config?.leaveTypeKey ?? leaveTypes[0]?.key ?? ''
  carryMaxDays = String(config?.maxDays ?? 5)
  carryExpires = (config?.expiresAfterMonths ?? null) !== null
  // The number keeps its last value while the switch is off, so turning it back on offers what was
  // there rather than an empty box.
  carryMonths = String(config?.expiresAfterMonths ?? 3)
  carryError = null
}

function openCarryEdit(policy: PolicyRow) {
  carryDialog = 'edit'
  carryId = policy.id
  carryFrom = policy.effectiveFrom
  fillCarryFrom(policy)
}

/** The same affordance as `openDuplicate`: a rule that changes from a date is a new policy. */
function openCarryDuplicate(policy: PolicyRow) {
  carryDialog = 'create'
  carryId = ''
  fillCarryFrom(policy)
  carryName = t('accr_copy_of', { name: policy.name })
  carryFrom = isoDate()
  carryTo = ''
}

const carryCap = $derived(clampedDays(carryMaxDays, 0, 365))
const carryExpiryMonths = $derived(clamped(carryMonths, 1, 24))

const carryProblem = $derived.by(() => {
  if (!carryName.trim()) return t('accr_error_name')
  if (!carryTypeKey) return t('cf_error_leave_type')
  if (!carryFrom) return t('accr_error_from')
  if (carryTo && carryTo < carryFrom) return t('accr_error_to_before_from')
  return null
})

const carryConfigDraft = $derived({
  leaveTypeKey: carryTypeKey,
  maxDays: carryCap,
  expiresAfterMonths: carryExpires ? carryExpiryMonths : null,
})

const saveCarry = createMutation(() => ({
  mutationFn: () =>
    carryDialog === 'edit'
      ? api.policies.update({
          workspaceId,
          policyId: carryId,
          name: carryName.trim(),
          config: $state.snapshot(carryConfigDraft),
          effectiveTo: carryTo || null,
        })
      : api.policies.create({
          workspaceId,
          kind: 'carry_forward',
          name: carryName.trim(),
          config: $state.snapshot(carryConfigDraft),
          effectiveFrom: carryFrom,
          effectiveTo: carryTo || null,
        }),
  onSuccess: (policy: Policy) => {
    toast.success(carryDialog === 'edit' ? t('accr_saved') : t('accr_created', { name: policy.name }))
    carryDialog = null
    carryError = null
    refresh()
  },
  onError: (error: Error) => {
    carryError = failureText(error, 'accr_save_error')
  },
  onSettled: settled,
}))

function carryMenu(policy: PolicyRow): MenuItem[] {
  return [
    { label: t('common.edit'), icon: 'square-pen', onSelect: () => openCarryEdit(policy) },
    { label: t('accr_duplicate'), icon: 'copy', onSelect: () => openCarryDuplicate(policy) },
    { label: t('accr_assign'), icon: 'user-plus', onSelect: () => openAssign(policy.id) },
    { type: 'separator' },
    {
      label: t('common.archive'),
      icon: 'archive',
      danger: true,
      disabled: Boolean(policy.archivedAt),
      hint: policy.archivedAt ? t('accr_already_archived') : undefined,
      onSelect: () => {
        archiving = policy
      },
    },
  ]
}

// ---------------------------------------------------------------- the ladder

/** Every rung needs a name for its subjects, and each name costs a request — so each is asked for
 *  only when a rung carries an assignment or the assign dialog is open on it. */
const rungInUse = (kind: PolicySubjectKind) => ladderAssignments.some((a) => a.subjectKind === kind)

let assignOpen = $state(false)
let assignRung = $state<PolicySubjectKind>('workspace')

const needsSubjects = (kind: PolicySubjectKind) => rungInUse(kind) || (assignOpen && assignRung === kind)

const peopleQuery = createQuery(() => ({
  queryKey: hrKeys.people(workspaceId, { forAccrual: true }),
  enabled: Boolean(workspaceId) && hasPeople && needsSubjects('person'),
  queryFn: () => api.people.list({ workspaceId, limit: 200, status: ['active', 'on_leave'] }),
}))
const officesQuery = createQuery(() => ({
  queryKey: hrKeys.offices(workspaceId),
  enabled: Boolean(workspaceId) && hasOffices && needsSubjects('office'),
  queryFn: () => api.offices.list({ workspaceId, includeArchived: false }),
}))
const entitiesQuery = createQuery(() => ({
  queryKey: hrKeys.entities(workspaceId),
  enabled: Boolean(workspaceId) && hasEntities && needsSubjects('legal_entity'),
  queryFn: () => api.entities.list({ workspaceId, includeArchived: false }),
}))
const unitsQuery = createQuery(() => ({
  queryKey: hrKeys.orgUnits(workspaceId),
  enabled: Boolean(workspaceId) && hasOrg && needsSubjects('org_unit'),
  queryFn: () => api.org.units.tree({ workspaceId, includeArchived: false }),
}))
const positionsQuery = createQuery(() => ({
  queryKey: ['hr', 'positions', workspaceId] as const,
  enabled: Boolean(workspaceId) && hasOrg && needsSubjects('position'),
  queryFn: () => api.org.positions.list({ workspaceId, includeArchived: false }),
}))

/** `{ id: name }` per rung, so a row and the picker read the same names from the same answer. */
const subjectNames = $derived.by(() => {
  const map: Record<PolicySubjectKind, Record<string, string>> = {
    person: {},
    office: {},
    legal_entity: {},
    org_unit: {},
    position: {},
    workspace: {},
  }
  for (const person of peopleQuery.data?.items ?? []) map.person[person.id] = person.displayName
  for (const office of officesQuery.data ?? []) map.office[office.id] = office.name
  for (const entity of entitiesQuery.data ?? []) map.legal_entity[entity.id] = entity.name
  for (const unit of unitsQuery.data ?? []) map.org_unit[unit.id] = unit.name
  for (const position of positionsQuery.data ?? []) map.position[position.id] = position.title
  return map
})

/** Whether this rung can be *named* at all, and why not when it cannot. */
const rungBlocked = (kind: PolicySubjectKind): string | null => {
  if (kind === 'workspace') return null
  if (kind === 'person') return hasPeople ? null : t('accr_rung_needs_people')
  if (kind === 'office') return hasOffices ? null : t('accr_rung_needs_offices')
  if (kind === 'legal_entity') return hasEntities ? null : t('accr_rung_needs_entities')
  return hasOrg ? null : t('accr_rung_needs_org')
}

/**
 * A subject's name, or an honest gap.
 *
 * A person who has left is not in the directory this page pulls, and an admin looking at the rung
 * needs to see that the assignment is still there rather than a blank cell — so the row says the
 * subject cannot be named and keeps its short id, which is what a support conversation needs.
 */
function subjectName(kind: PolicySubjectKind, id: string | null): string {
  if (kind === 'workspace') return workspace?.name ?? t('accr_rung_workspace')
  if (!id) return t('accr_subject_missing')
  return subjectNames[kind][id] ?? t('accr_subject_unknown', { id: id.slice(0, 8) })
}

type LadderRow = { assignment: PolicyAssignment; policy: PolicyRow }

const ladder = $derived(
  LADDER.map((kind) => ({
    kind,
    rows: ladderPolicies
      .flatMap((policy) =>
        policy.assignments
          .filter((assignment) => assignment.subjectKind === kind)
          .map((assignment): LadderRow => ({ assignment, policy })),
      )
      // Subject first, then kind: one person's two policies belong next to each other, and reading
      // down a rung is reading down a list of people rather than a list of policy kinds.
      .sort(
        (a, b) =>
          subjectName(kind, a.assignment.subjectId).localeCompare(
            subjectName(kind, b.assignment.subjectId),
            messageLocale(),
          ) || kindLabel(a.policy.kind).localeCompare(kindLabel(b.policy.kind), messageLocale()),
      ),
  })),
)

const rangeLabel = (from: string, to: string | null): string =>
  to ? formatDateRange(from, to) : t('accr_from_date', { date: formatDate(from) })

// ---------------------------------------------------------------- assigning

let assignPolicyId = $state('')
let assignSubjectId = $state('')
let assignFrom = $state(isoDate())
let assignTo = $state('')
let assignError = $state<string | null>(null)

function openAssign(preferredId?: string) {
  assignOpen = true
  assignPolicyId = preferredId ?? ladderPolicies[0]?.id ?? ''
  assignRung = 'workspace'
  assignSubjectId = ''
  assignFrom = isoDate()
  assignTo = ''
  assignError = null
}

function pickRung(next: string) {
  assignRung = next as PolicySubjectKind
  assignSubjectId = ''
}

const subjectChoices = $derived(
  Object.entries(subjectNames[assignRung])
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label, messageLocale())),
)

const subjectsLoading = $derived(
  assignRung === 'person'
    ? peopleQuery.isLoading
    : assignRung === 'office'
      ? officesQuery.isLoading
      : assignRung === 'legal_entity'
        ? entitiesQuery.isLoading
        : assignRung === 'org_unit'
          ? unitsQuery.isLoading
          : assignRung === 'position'
            ? positionsQuery.isLoading
            : false,
)

/** The rungs that still beat the one being chosen. Drawn as chips rather than written into a
 *  sentence, so the order reads down the ladder in every writing direction. */
const beatenBy = $derived(LADDER.slice(0, LADDER.indexOf(assignRung)))

/** The policy being assigned, and therefore which kind the rung is being read for. */
const assignKind = $derived(ladderPolicies.find((p) => p.id === assignPolicyId)?.kind ?? 'accrual')

/**
 * Another policy **of the same kind** already sitting on this exact subject, open-ended.
 *
 * Two policies of one kind on one rung is not refused by the server — their effective ranges may
 * well separate them — but it is the ambiguity this whole screen exists to surface, so it is named
 * rather than blocked. Across kinds there is no ambiguity at all: accrual and carry-forward are
 * resolved separately, so warning about an accrual policy while a carry-forward one is being
 * assigned would invent a conflict that does not exist.
 */
const rungTaken = $derived(
  assignOpen
    ? (ladderPolicies.find(
        (policy) =>
          policy.kind === assignKind &&
          policy.assignments.some(
            (assignment) =>
              assignment.subjectKind === assignRung &&
              (assignment.subjectId ?? '') === (assignRung === 'workspace' ? '' : assignSubjectId) &&
              assignment.effectiveTo === null &&
              policy.id !== assignPolicyId,
          ),
      ) ?? null)
    : null,
)

const assignProblem = $derived.by(() => {
  if (!assignPolicyId) return t('accr_error_pick_policy')
  const blocked = rungBlocked(assignRung)
  if (blocked) return blocked
  if (assignRung !== 'workspace' && !assignSubjectId) return t('accr_error_pick_subject')
  if (!assignFrom) return t('accr_error_from')
  if (assignTo && assignTo < assignFrom) return t('accr_error_to_before_from')
  return null
})

const assign = createMutation(() => ({
  mutationFn: () =>
    api.policies.assign({
      workspaceId,
      policyId: assignPolicyId,
      subjectKind: assignRung,
      subjectId: assignRung === 'workspace' ? null : assignSubjectId,
      effectiveFrom: assignFrom,
      effectiveTo: assignTo || null,
    }),
  onSuccess: () => {
    toast.success(
      t('accr_assigned', {
        name: policies.find((p) => p.id === assignPolicyId)?.name ?? '',
        subject: subjectName(assignRung, assignSubjectId || null),
      }),
    )
    assignOpen = false
    assignError = null
    refresh()
  },
  onError: (error: Error) => {
    assignError = failureText(error, 'accr_assign_error')
  },
  onSettled: settled,
}))

let unassigning = $state<LadderRow | null>(null)

const unassignIsCarry = $derived(unassigning?.policy.kind === 'carry_forward')
/**
 * What the people under this assignment fall through to, in the kind being removed.
 *
 * The bottom rung is only a fallback for its own kind: naming the accrual policy while a
 * carry-forward assignment is being removed would promise that leave still carries when nothing
 * carries it any more.
 */
const unassignFallback = $derived(
  unassigning === null || unassigning.assignment.subjectKind === 'workspace'
    ? null
    : unassignIsCarry
      ? carryDefault
      : workspaceDefault,
)

const unassign = createMutation(() => ({
  mutationFn: (row: LadderRow) => api.policies.unassign({ workspaceId, assignmentId: row.assignment.id }),
  onSuccess: (_ok, row: LadderRow) => {
    toast.success(
      t('accr_unassigned', {
        name: row.policy.name,
        subject: subjectName(row.assignment.subjectKind, row.assignment.subjectId),
      }),
    )
    unassigning = null
    refresh()
  },
  onError: (error: Error) => toast.error(failureText(error, 'accr_unassign_error')),
  onSettled: settled,
}))

// ---------------------------------------------------------------- preview, then run

let runOpen = $state(false)
/** Last month, because that is the period the job credits when a month turns. */
const lastMonth = monthRange(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1))
let runFrom = $state(lastMonth.from)
let runTo = $state(lastMonth.to)

const runRangeValid = $derived(Boolean(runFrom && runTo && runFrom <= runTo))

const previewQuery = createQuery(() => ({
  queryKey: ['hr', 'accrual-preview', workspaceId, runFrom, runTo] as const,
  enabled: Boolean(runOpen && workspaceId && runRangeValid),
  // A period that computes to nothing is an answer, not a network blip: no point retrying it three
  // times behind a spinner while somebody waits to read numbers.
  retry: false,
  queryFn: () => api.accrual.preview({ workspaceId, from: runFrom, to: runTo }),
}))
const preview = $derived(previewQuery.data ?? null)

/** What a run would actually write. `alreadyAccrued` rows are the idempotence, drawn but not counted. */
const creditable = $derived(
  preview ? preview.rows.filter((row) => !row.alreadyAccrued && row.minutes > 0) : [],
)
const alreadyDone = $derived(preview ? preview.rows.filter((row) => row.alreadyAccrued).length : 0)

const runAccrual = createMutation(() => ({
  mutationFn: () => api.accrual.run({ workspaceId, from: runFrom, to: runTo }),
  onSuccess: (result: { credited: number; skipped: number; totalMinutes: number }) => {
    toast.success(t('accr_run_done', { count: result.credited }))
    runOpen = false
    refresh()
  },
  onError: (error: Error) => toast.error(failureText(error, 'accr_run_error')),
  onSettled: settled,
}))

/** Long lists are for reading, not for scrolling past — the tail is counted instead. */
const HEAD = 10
</script>

<SettingsPage title={t('settings_accrual')} description={t('accr_desc')}>
  {#snippet actions()}
    <!-- One switch for both lists below, so it sits above both rather than inside one of them and
         silently filtering the other. Each section keeps its own "new" button. -->
    {#if policies.length > 0 || carryPolicies.length > 0 || showArchived}
      <Switch
        size="sm"
        checked={showArchived}
        onCheckedChange={(on) => (showArchived = on)}
        label={t('accr_show_archived')}
      />
    {/if}
  {/snippet}

  {#if !manage}
    <!-- Typed straight into the address bar: every write below will be refused, so say it once
         rather than letting somebody find out one button at a time. -->
    <p class="note warn" role="status">{t('accr_readonly')}</p>
  {/if}

  {#if stale}
    <p class="stale" role="status">
      <span>{t('accr_stale')}</span>
      <Button
        size="sm"
        variant="ghost"
        onclick={() => {
          void policiesQuery.refetch()
          void carryQuery.refetch()
        }}
      >
        {t('retry')}
      </Button>
    </p>
  {/if}

  <SettingsSection title={t('accr_policies')} description={t('accr_policies_desc')}>
    {#snippet action()}
      {#if manage}
        <Button size="sm" icon="plus" onclick={openCreate}>{t('accr_new')}</Button>
      {/if}
    {/snippet}

    {#if policiesLoading}
      <div class="rows">
        {#each [1, 2, 3] as n (n)}<Skeleton height="52px" />{/each}
      </div>
    {:else if policies.length}
      <div class="tiles">
        <StatTile size="md" label={t('accr_stat_policies')} value={formatCount(livePolicies.length, 99)} />
        <StatTile
          size="md"
          label={t('accr_stat_assignments')}
          value={formatCount(liveAssignments.length, 999)}
        />
        <StatTile
          size="md"
          label={t('accr_stat_default')}
          value={workspaceDefault ? workspaceDefault.name : t('accr_stat_default_none')}
          note={workspaceDefault ? null : t('accr_stat_default_none_note')}
        />
      </div>

      <div class="table" role="table" aria-label={t('accr_policies')}>
        <div class="thead" role="row">
          <span role="columnheader">{t('accr_col_policy')}</span>
          <span role="columnheader">{t('accr_col_earns')}</span>
          <span role="columnheader">{t('accr_col_when')}</span>
          <span role="columnheader">{t('accr_col_applies')}</span>
          <span class="sr-only" role="columnheader">{t('approvals_actions')}</span>
        </div>
        {#each policies as policy (policy.id)}
          {@const config = configOf(policy)}
          <div class="trow" role="row">
            <span class="cell what" role="cell">
              <span class="strong">{policy.name}</span>
              <span class="chips">
                {#if policy.archivedAt}
                  <Badge tone="grey">{t('accr_badge_archived')}</Badge>
                {/if}
                {#if policy.source === 'pack'}
                  <Badge tone="grey">{t('cal_origin_pack')}</Badge>
                {/if}
              </span>
              <span class="sub">{rangeLabel(policy.effectiveFrom, policy.effectiveTo)}</span>
            </span>

            <span class="cell" role="cell">
              {#if config}
                <span class="num">{t('accr_days_per_year', { count: config.daysPerYear })}</span>
                <span class="sub">
                  <!-- The day length is named rather than left as a bare duration beside a leave
                       type, because it is the number those days per year are earned in. -->
                  {leaveTypeName(config.leaveTypeKey)} · {t('accr_day_is', {
                    length: duration(config.minutesPerDay),
                  })}
                  {#if config.seniorityTiers.length > 0}
                    · {t('accr_tiers_count', { count: config.seniorityTiers.length })}
                  {/if}
                </span>
              {:else}
                <!-- A row whose config the schema cannot read: say so rather than print undefined. -->
                <span class="sub danger">{t('accr_config_unreadable')}</span>
              {/if}
            </span>

            <span class="cell" role="cell">
              {#if config}
                <Badge tone="info">{freqLabel(config.frequency)}</Badge>
                <span class="sub">
                  {#if config.waitingPeriodMonths > 0}
                    {t('accr_waiting_short', { count: config.waitingPeriodMonths })}
                  {/if}
                  {#if config.roundToMinutes > 0}
                    {#if config.waitingPeriodMonths > 0}·{/if}
                    {t('accr_round_short', { step: duration(config.roundToMinutes) })}
                  {/if}
                </span>
              {/if}
            </span>

            <span class="cell num" role="cell">
              {#if policy.assignments.length > 0}
                {formatCount(policy.assignments.length, 999)}
              {:else}
                <span class="sub warn-text">{t('accr_nobody')}</span>
              {/if}
            </span>

            <span class="cell actions" role="cell">
              {#if manage}
                <DropdownMenu items={policyMenu(policy)}>
                  {#snippet trigger(props)}
                    <IconButton
                      icon="ellipsis"
                      label={t('accr_actions_for', { name: policy.name })}
                      size={28}
                      {...props}
                    />
                  {/snippet}
                </DropdownMenu>
              {/if}
            </span>
          </div>
        {/each}
      </div>
    {:else if policiesQuery.isError}
      <EmptyState icon="triangle-alert" title={t('accr_error')} description={t('accr_error_desc')}>
        {#snippet actions()}
          <Button variant="secondary" onclick={() => void policiesQuery.refetch()}>{t('retry')}</Button>
        {/snippet}
      </EmptyState>
    {:else}
      <EmptyState icon="gauge" title={t('accr_none')} description={t('accr_none_desc')}>
        {#snippet actions()}
          {#if manage}
            <Button icon="plus" onclick={openCreate}>{t('accr_new')}</Button>
          {/if}
        {/snippet}
      </EmptyState>
    {/if}
  </SettingsSection>

  <!-- ---------------------------------------------------------------- carry-forward -->
  <SettingsSection title={t('cf_section')} description={t('cf_section_desc')}>
    {#snippet action()}
      {#if manage}
        <Button size="sm" icon="plus" onclick={openCarryCreate}>{t('accr_new')}</Button>
      {/if}
    {/snippet}

    {#if carryLoading}
      <div class="rows">
        {#each [1, 2] as n (n)}<Skeleton height="52px" />{/each}
      </div>
    {:else if carryPolicies.length}
      <div class="stack">
        {#if !carryDefault}
          <!-- Same silence as the accrual ladder's missing bottom rung, and a different sentence:
               nothing is refused, people simply keep nothing at the turn of the year. -->
          <p class="note warn">{t('cf_no_default')}</p>
        {/if}
        {#if !policiesLoading && livePolicies.length === 0}
          <!-- The job converts a cap in days with the day length from that person's *accrual*
               policy, and skips them when there is none. A cap with no accrual policy anywhere is
               therefore a rule that cannot run at all — said only once the accrual list has
               actually answered, so the warning cannot flash while it loads. -->
          <p class="note warn">{t('cf_needs_accrual')}</p>
        {/if}

        <div class="table cf" role="table" aria-label={t('cf_section')}>
          <div class="thead" role="row">
            <span role="columnheader">{t('accr_col_policy')}</span>
            <span role="columnheader">{t('cf_col_carries')}</span>
            <span role="columnheader">{t('cf_col_deadline')}</span>
            <span role="columnheader">{t('accr_col_applies')}</span>
            <span class="sr-only" role="columnheader">{t('approvals_actions')}</span>
          </div>
          {#each carryPolicies as policy (policy.id)}
            {@const config = carryConfigOf(policy)}
            <div class="trow" role="row">
              <span class="cell what" role="cell">
                <span class="strong">{policy.name}</span>
                <span class="chips">
                  {#if policy.archivedAt}
                    <Badge tone="grey">{t('accr_badge_archived')}</Badge>
                  {/if}
                  {#if policy.source === 'pack'}
                    <Badge tone="grey">{t('cal_origin_pack')}</Badge>
                  {/if}
                </span>
                <span class="sub">{rangeLabel(policy.effectiveFrom, policy.effectiveTo)}</span>
              </span>

              <span class="cell" role="cell">
                {#if config}
                  {#if config.maxDays > 0}
                    <span class="num">
                      {days(config.maxDays)}
                      {t('days', { count: config.maxDays })}
                    </span>
                  {:else}
                    <!-- A cap of zero is a real answer and a drastic one: the whole remaining
                         balance is written off as an expiry entry. It is named, not left as "0". -->
                    <span class="warn-text">{t('cf_carries_nothing')}</span>
                  {/if}
                  <span class="sub">{leaveTypeName(config.leaveTypeKey)}</span>
                {:else}
                  <span class="sub danger">{t('accr_config_unreadable')}</span>
                {/if}
              </span>

              <span class="cell" role="cell">
                {#if config}
                  {#if config.expiresAfterMonths === null}
                    <Badge tone="grey">{t('cf_no_deadline')}</Badge>
                  {:else}
                    <Badge tone="warning">
                      {t('cf_deadline_short', { count: config.expiresAfterMonths })}
                    </Badge>
                  {/if}
                {/if}
              </span>

              <span class="cell num" role="cell">
                {#if policy.assignments.length > 0}
                  {formatCount(policy.assignments.length, 999)}
                {:else}
                  <span class="sub warn-text">{t('accr_nobody')}</span>
                {/if}
              </span>

              <span class="cell actions" role="cell">
                {#if manage}
                  <DropdownMenu items={carryMenu(policy)}>
                    {#snippet trigger(props)}
                      <IconButton
                        icon="ellipsis"
                        label={t('accr_actions_for', { name: policy.name })}
                        size={28}
                        {...props}
                      />
                    {/snippet}
                  </DropdownMenu>
                {/if}
              </span>
            </div>
          {/each}
        </div>

        <p class="note">{t('cf_job_note')}</p>
      </div>
    {:else if carryQuery.isError}
      <EmptyState icon="triangle-alert" title={t('cf_error')} description={t('accr_error_desc')}>
        {#snippet actions()}
          <Button variant="secondary" onclick={() => void carryQuery.refetch()}>{t('retry')}</Button>
        {/snippet}
      </EmptyState>
    {:else}
      <EmptyState icon="calendar-days" title={t('cf_none')} description={t('cf_none_desc')}>
        {#snippet actions()}
          {#if manage}
            <Button icon="plus" onclick={openCarryCreate}>{t('accr_new')}</Button>
          {/if}
        {/snippet}
      </EmptyState>
    {/if}
  </SettingsSection>

  <!-- ---------------------------------------------------------------- the ladder -->
  <SettingsSection title={t('accr_ladder')} description={t('accr_ladder_desc')}>
    {#snippet action()}
      {#if manage && ladderPolicies.length > 0}
        <Button size="sm" variant="secondary" icon="user-plus" onclick={() => openAssign()}>
          {t('accr_assign')}
        </Button>
      {/if}
    {/snippet}

    {#if policiesLoading || carryLoading}
      <div class="rows">
        {#each [1, 2, 3, 4] as n (n)}<Skeleton height="44px" />{/each}
      </div>
    {:else if ladderAssignments.length}
      {#if !workspaceDefault}
        <!-- The bottom rung is the only one that catches everybody, and its absence is silent
             everywhere else: people with nothing nearer simply never accrue. -->
        <p class="note warn">{t('accr_no_default')}</p>
      {/if}

      <div class="ladder">
        {#each ladder as rung (rung.kind)}
          <div class="rung" class:empty={rung.rows.length === 0}>
            <SectionLabel label={rungLabel(rung.kind)} count={rung.rows.length} sub />
            <p class="hint">{rungHint(rung.kind)}</p>

            {#if rung.rows.length === 0}
              <p class="sub">{t('accr_rung_empty')}</p>
            {:else}
              <ul class="rlist">
                {#each rung.rows as row (row.assignment.id)}
                  <li>
                    <span class="rsubject">
                      <Badge tone="grey">{rungLabel(rung.kind)}</Badge>
                      <span class="strong">{subjectName(rung.kind, row.assignment.subjectId)}</span>
                    </span>
                    <span class="rpolicy">
                      <!-- Which kind is on this rung. Two policies on one subject is ordinary here
                           — accrual and carry-forward are resolved separately — and without the
                           badge the pair reads as a conflict rather than as two answers. -->
                      <Badge tone={row.policy.kind === 'carry_forward' ? 'info' : 'accent'}>
                        {kindLabel(row.policy.kind)}
                      </Badge>
                      <span class="rname">{row.policy.name}</span>
                    </span>
                    <span class="sub rwhen">
                      {rangeLabel(row.assignment.effectiveFrom, row.assignment.effectiveTo)}
                    </span>
                    {#if manage}
                      <IconButton
                        icon="trash-2"
                        label={t('accr_unassign_label', {
                          name: row.policy.name,
                          subject: subjectName(rung.kind, row.assignment.subjectId),
                        })}
                        size={28}
                        onclick={() => (unassigning = row)}
                      />
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/each}
      </div>
    {:else if policiesQuery.isError || carryQuery.isError}
      <EmptyState icon="triangle-alert" title={t('accr_ladder_error')}>
        {#snippet actions()}
          <Button
            variant="secondary"
            onclick={() => {
              void policiesQuery.refetch()
              void carryQuery.refetch()
            }}
          >
            {t('retry')}
          </Button>
        {/snippet}
      </EmptyState>
    {:else}
      <EmptyState
        icon="git-branch"
        title={t('accr_ladder_none')}
        description={ladderPolicies.length > 0
          ? t('accr_ladder_none_desc')
          : t('accr_ladder_needs_policy')}
      >
        {#snippet actions()}
          {#if manage && ladderPolicies.length > 0}
            <Button icon="user-plus" onclick={() => openAssign()}>{t('accr_assign')}</Button>
          {:else if manage}
            <Button icon="plus" onclick={openCreate}>{t('accr_new')}</Button>
          {/if}
        {/snippet}
      </EmptyState>
    {/if}
  </SettingsSection>

  <!-- ---------------------------------------------------------------- crediting -->
  <SettingsSection title={t('accr_run_section')} description={t('accr_run_section_desc')}>
    <p class="note">{t('accr_job_note')}</p>
    {#if manage && livePolicies.length === 0}
      <!-- Disabled with the reason beside it, rather than a dead button somebody clicks twice. -->
      <p class="hint spaced">{t('accr_run_needs_policy')}</p>
    {/if}
    {#snippet footer()}
      <Button
        variant="secondary"
        icon="play"
        disabled={!manage || livePolicies.length === 0}
        onclick={() => {
          runOpen = true
        }}
      >
        {t('accr_run_open')}
      </Button>
    {/snippet}
  </SettingsSection>
</SettingsPage>

<!-- ---------------------------------------------------------------- the policy form -->
<Dialog
  open={policyDialog !== null}
  size="lg"
  title={policyDialog === 'edit' ? t('accr_edit_title') : t('accr_create_title')}
  onOpenChange={(open) => {
    if (!open) policyDialog = null
  }}
>
  <div class="form">
    {#if policyDialog === 'edit'}
      <!-- The contract's own rule, said where it matters: an edit rewrites what was true in the
           past, and everything already derived from it becomes unexplainable. -->
      <p class="note">{t('accr_edit_retroactive')}</p>
    {/if}

    {#if seededFromUnreadable}
      <!-- Every field below is a default, the day length included — and the day length is what the
           engine multiplies entitlement days by. Saying so is the difference between repairing a
           broken row and overwriting a working one with eight hours and twenty days. -->
      <p class="note warn">{t('accr_config_unreadable_form')}</p>
    {/if}

    <Field label={t('accr_name')} hint={t('accr_name_hint')} required>
      {#snippet children(id)}
        <Input {id} bind:value={policyName} maxlength={120} />
      {/snippet}
    </Field>

    <Field label={t('accr_frequency')} hint={freqDesc(frequency)}>
      {#snippet children(id)}
        <Select
          {id}
          value={frequency}
          onValueChange={(v) => (frequency = v as Frequency)}
          options={FREQUENCIES.map((f) => ({ value: f, label: freqLabel(f) }))}
        />
      {/snippet}
    </Field>

    {#if frequency === 'per_hour_worked' && !hasAttendance}
      <!-- The ratio it accrues on is worked minutes over scheduled minutes, and both come from
           attendance day sheets. Without them the divisor is zero and every run skips everybody. -->
      <p class="note warn">{t('accr_needs_attendance')}</p>
    {/if}

    <Field label={t('accr_leave_type')} hint={t('accr_leave_type_hint')} required>
      {#snippet children(id)}
        <Select
          {id}
          value={leaveTypeKey}
          onValueChange={(v) => (leaveTypeKey = v)}
          placeholder={t('accr_leave_type_pick')}
          ariaLabel={t('accr_leave_type')}
          options={leaveTypes.map((type) => ({ value: type.key, label: type.name }))}
        />
      {/snippet}
    </Field>

    {#if leaveTypes.length === 0 && !leaveTypesQuery.isLoading}
      <p class="note warn">
        {t('accr_no_leave_types')}
        {#if canHr('leaveManage')}
          <a class="link" href={`/${workspaceSlug}/settings/hr/leave`}>{t('settings_leave')}</a>
        {/if}
      </p>
    {/if}

    <div class="pair">
      <Field label={t('accr_days_field')} hint={t('accr_days_field_hint')}>
        {#snippet children(id)}
          <Input {id} type="number" min={0} max={365} step={0.5} bind:value={daysPerYear} />
        {/snippet}
      </Field>
      <Field label={t('accr_day_length')} hint={t('accr_day_length_hint', { length: duration(dayMinutes) })}>
        {#snippet children(id)}
          <Input {id} type="number" min={1} max={1440} bind:value={minutesPerDay} />
        {/snippet}
      </Field>
    </div>

    <div class="pair">
      <Field label={t('accr_waiting')} hint={t('accr_waiting_hint')}>
        {#snippet children(id)}
          <Input {id} type="number" min={0} max={24} bind:value={waitingMonths} />
        {/snippet}
      </Field>
      <Field label={t('accr_rounding')} hint={t('accr_rounding_hint')}>
        {#snippet children(id)}
          <Select
            {id}
            value={roundChoice}
            onValueChange={(v) => (roundChoice = v)}
            options={roundOptions}
          />
        {/snippet}
      </Field>
    </div>

    <div class="tierbox">
      <SectionLabel label={t('accr_tiers')} count={tiers.length} sub>
        {#snippet trailing()}
          <Button
            size="xs"
            variant="ghost"
            icon="plus"
            onclick={() => (tiers = [...tiers, { afterYears: '5', daysPerYear: daysPerYear }])}
          >
            {t('accr_tier_add')}
          </Button>
        {/snippet}
      </SectionLabel>
      <p class="hint">{t('accr_tiers_hint')}</p>

      {#if tiers.length === 0}
        <p class="sub">{t('accr_tiers_none', { count: clampedDays(daysPerYear, 0, 365) })}</p>
      {:else}
        <ul class="tiers">
          {#each tiers as tier, index (index)}
            <li>
              <Field label={t('accr_tier_after')}>
                {#snippet children(id)}
                  <Input {id} size="sm" type="number" min={0} max={60} bind:value={tier.afterYears} />
                {/snippet}
              </Field>
              <Field label={t('accr_tier_days')}>
                {#snippet children(id)}
                  <Input
                    {id}
                    size="sm"
                    type="number"
                    min={0}
                    max={365}
                    step={0.5}
                    bind:value={tier.daysPerYear}
                  />
                {/snippet}
              </Field>
              <IconButton
                icon="trash-2"
                label={t('accr_tier_remove', { years: clamped(tier.afterYears, 0, 60) })}
                size={28}
                onclick={() => (tiers = tiers.filter((_, i) => i !== index))}
              />
            </li>
          {/each}
        </ul>
      {/if}
      {#if tiersClash}
        <p class="hint danger" role="alert">{t('accr_error_tier_clash')}</p>
      {/if}
    </div>

    <div class="pair">
      <Field label={t('accr_effective_from')} hint={t('accr_effective_from_hint')} required>
        {#snippet children(id)}
          <Input {id} type="date" bind:value={policyFrom} disabled={policyDialog === 'edit'} />
        {/snippet}
      </Field>
      <Field label={t('accr_effective_to')} hint={t('accr_effective_to_hint')}>
        {#snippet children(id)}
          <Input {id} type="date" bind:value={policyTo} />
        {/snippet}
      </Field>
    </div>

    {#if policyError}
      <p class="note danger-note" role="alert">{policyError}</p>
    {/if}
  </div>

  {#snippet footer()}
    {#if formProblem}
      <span class="hint problem">{formProblem}</span>
    {/if}
    <Button variant="secondary" onclick={() => (policyDialog = null)} disabled={savePolicy.isPending}>
      {t('cancel')}
    </Button>
    <Button
      loading={savePolicy.isPending}
      disabled={!manage || formProblem !== null}
      onclick={() => once(() => savePolicy.mutate())}
    >
      {policyDialog === 'edit' ? t('common.save') : t('common.create')}
    </Button>
  {/snippet}
</Dialog>

<!-- ---------------------------------------------------------------- the carry-forward form -->
<Dialog
  open={carryDialog !== null}
  title={carryDialog === 'edit' ? t('cf_edit_title') : t('cf_create_title')}
  onOpenChange={(open) => {
    if (!open) carryDialog = null
  }}
>
  <div class="form">
    {#if carryDialog === 'edit'}
      <p class="note">{t('accr_edit_retroactive')}</p>
    {/if}

    {#if carrySeededFromUnreadable}
      <p class="note warn">{t('accr_config_unreadable_form')}</p>
    {/if}

    <Field label={t('accr_name')} hint={t('accr_name_hint')} required>
      {#snippet children(id)}
        <Input {id} bind:value={carryName} maxlength={120} />
      {/snippet}
    </Field>

    <Field label={t('accr_leave_type')} hint={t('cf_leave_type_hint')} required>
      {#snippet children(id)}
        <Select
          {id}
          value={carryTypeKey}
          onValueChange={(v) => (carryTypeKey = v)}
          placeholder={t('accr_leave_type_pick')}
          ariaLabel={t('accr_leave_type')}
          options={leaveTypes.map((type) => ({ value: type.key, label: type.name }))}
        />
      {/snippet}
    </Field>

    {#if leaveTypes.length === 0 && !leaveTypesQuery.isLoading}
      <p class="note warn">
        {t('accr_no_leave_types')}
        {#if canHr('leaveManage')}
          <a class="link" href={`/${workspaceSlug}/settings/hr/leave`}>{t('settings_leave')}</a>
        {/if}
      </p>
    {/if}

    <Field label={t('cf_cap')} hint={t('cf_cap_hint')}>
      {#snippet children(id)}
        <Input {id} type="number" min={0} max={365} step={0.5} bind:value={carryMaxDays} />
      {/snippet}
    </Field>

    {#if carryCap === 0}
      <!-- Not a disabled rule: a zero cap writes the whole closing balance off as an expiry entry,
           which is the most drastic thing this form can save. -->
      <p class="note warn">{t('cf_cap_zero')}</p>
    {/if}

    <!-- A switch and a number rather than an empty box meaning "never": both are real answers, and
         a blank field does not say which of them it is. Nothing is disabled — the months field is
         simply not there while there is no deadline to describe. -->
    <Switch
      checked={carryExpires}
      onCheckedChange={(on) => (carryExpires = on)}
      label={t('cf_expires')}
      description={t('cf_expires_hint')}
    />

    {#if carryExpires}
      <Field label={t('cf_months')} hint={t('cf_months_hint')}>
        {#snippet children(id)}
          <Input {id} type="number" min={1} max={24} bind:value={carryMonths} />
        {/snippet}
      </Field>
    {/if}

    <div class="pair">
      <Field label={t('accr_effective_from')} hint={t('accr_effective_from_hint')} required>
        {#snippet children(id)}
          <Input {id} type="date" bind:value={carryFrom} disabled={carryDialog === 'edit'} />
        {/snippet}
      </Field>
      <Field label={t('accr_effective_to')} hint={t('accr_effective_to_hint')}>
        {#snippet children(id)}
          <Input {id} type="date" bind:value={carryTo} />
        {/snippet}
      </Field>
    </div>

    <p class="note">{t('cf_needs_accrual_note')}</p>

    {#if carryError}
      <p class="note danger-note" role="alert">{carryError}</p>
    {/if}
  </div>

  {#snippet footer()}
    {#if carryProblem}
      <span class="hint problem">{carryProblem}</span>
    {/if}
    <Button variant="secondary" onclick={() => (carryDialog = null)} disabled={saveCarry.isPending}>
      {t('cancel')}
    </Button>
    <Button
      loading={saveCarry.isPending}
      disabled={!manage || carryProblem !== null}
      onclick={() => once(() => saveCarry.mutate())}
    >
      {carryDialog === 'edit' ? t('common.save') : t('common.create')}
    </Button>
  {/snippet}
</Dialog>

<!-- ---------------------------------------------------------------- archive a policy -->
<Dialog
  open={archiving !== null}
  size="sm"
  title={archiving ? t('accr_archive_title', { name: archiving.name }) : ''}
  description={t('accr_archive_body')}
  onOpenChange={(open) => {
    if (!open) archiving = null
  }}
>
  {#if archiving}
    <p class="body">{t('accr_archive_keeps')}</p>
    {#if archiving.assignments.length > 0}
      <p class="body warn-text">
        {t('accr_archive_assigned', { count: archiving.assignments.length })}
      </p>
    {/if}
  {/if}

  {#snippet footer()}
    <Button variant="secondary" onclick={() => (archiving = null)} disabled={archivePolicy.isPending}>
      {t('cancel')}
    </Button>
    <Button
      variant="danger"
      loading={archivePolicy.isPending}
      onclick={() => {
        if (archiving) once(() => archiving && archivePolicy.mutate(archiving))
      }}
    >
      {t('common.archive')}
    </Button>
  {/snippet}
</Dialog>

<!-- ---------------------------------------------------------------- assign a policy -->
<Dialog
  open={assignOpen}
  title={t('accr_assign_title')}
  description={t('accr_assign_desc')}
  onOpenChange={(open) => {
    if (!open) assignOpen = false
  }}
>
  <div class="form">
    <Field label={t('accr_assign_policy')} required>
      {#snippet children(id)}
        <Select
          {id}
          value={assignPolicyId}
          onValueChange={(v) => (assignPolicyId = v)}
          placeholder={t('accr_assign_policy_pick')}
          ariaLabel={t('accr_assign_policy')}
          options={ladderPolicies.map((policy) => ({
            value: policy.id,
            label: policy.name,
            // Grouped by kind rather than labelled with it: which rung a policy may sit on is the
            // same question for both, but "5 days" means nothing until you know which it is.
            group: kindLabel(policy.kind),
          }))}
        />
      {/snippet}
    </Field>

    <Field label={t('accr_assign_rung')} hint={rungHint(assignRung)} required>
      {#snippet children(id)}
        <Select
          {id}
          value={assignRung}
          onValueChange={pickRung}
          options={LADDER.map((kind) => ({
            value: kind,
            label: rungLabel(kind),
          }))}
        />
      {/snippet}
    </Field>

    {#if beatenBy.length > 0}
      <div class="beaten">
        <span class="hint">{t('accr_beaten_by')}</span>
        <span class="chips">
          {#each beatenBy as kind (kind)}
            <Badge tone="warning">{rungLabel(kind)}</Badge>
          {/each}
        </span>
      </div>
    {:else}
      <p class="hint">{t('accr_beats_everything')}</p>
    {/if}

    {#if assignRung !== 'workspace'}
      {@const blocked = rungBlocked(assignRung)}
      <Field label={t('accr_assign_subject', { rung: rungLabel(assignRung) })} error={blocked} required>
        {#snippet children(id)}
          <Select
            {id}
            value={assignSubjectId}
            onValueChange={(v) => (assignSubjectId = v)}
            disabled={Boolean(blocked) || subjectsLoading || subjectChoices.length === 0}
            placeholder={subjectsLoading ? t('accr_subject_loading') : t('accr_subject_pick')}
            ariaLabel={t('accr_assign_subject', { rung: rungLabel(assignRung) })}
            options={subjectChoices}
          />
        {/snippet}
      </Field>
      {#if !blocked && !subjectsLoading && subjectChoices.length === 0}
        <p class="hint">{t('accr_subject_none', { rung: rungLabel(assignRung) })}</p>
      {/if}
    {/if}

    {#if rungTaken}
      <p class="note warn">
        {t('accr_rung_taken', {
          name: rungTaken.name,
          subject: subjectName(assignRung, assignSubjectId || null),
        })}
      </p>
    {/if}

    <div class="pair">
      <Field label={t('accr_effective_from')} required>
        {#snippet children(id)}
          <Input {id} type="date" bind:value={assignFrom} />
        {/snippet}
      </Field>
      <Field label={t('accr_effective_to')} hint={t('accr_assign_to_hint')}>
        {#snippet children(id)}
          <Input {id} type="date" bind:value={assignTo} />
        {/snippet}
      </Field>
    </div>

    {#if assignError}
      <p class="note danger-note" role="alert">{assignError}</p>
    {/if}
  </div>

  {#snippet footer()}
    {#if assignProblem}
      <span class="hint problem">{assignProblem}</span>
    {/if}
    <Button variant="secondary" onclick={() => (assignOpen = false)} disabled={assign.isPending}>
      {t('cancel')}
    </Button>
    <Button
      loading={assign.isPending}
      disabled={!manage || assignProblem !== null}
      onclick={() => once(() => assign.mutate())}
    >
      {t('accr_assign')}
    </Button>
  {/snippet}
</Dialog>

<!-- ---------------------------------------------------------------- unassign -->
<Dialog
  open={unassigning !== null}
  size="sm"
  title={unassigning
    ? t(unassignIsCarry ? 'cf_unassign_title' : 'accr_unassign_title', {
        subject: subjectName(unassigning.assignment.subjectKind, unassigning.assignment.subjectId),
      })
    : ''}
  description={unassigning ? t('accr_unassign_body', { name: unassigning.policy.name }) : ''}
  onOpenChange={(open) => {
    if (!open) unassigning = null
  }}
>
  {#if unassigning}
    <!-- What happens to the people underneath is the whole question, and it has two answers. -->
    <p class="body">
      {unassignFallback
        ? t('accr_unassign_falls_back', { name: unassignFallback.name })
        : t(unassignIsCarry ? 'cf_unassign_no_fallback' : 'accr_unassign_no_fallback')}
    </p>
    <p class="body sub">{t('accr_unassign_keeps')}</p>
  {/if}

  {#snippet footer()}
    <Button variant="secondary" onclick={() => (unassigning = null)} disabled={unassign.isPending}>
      {t('cancel')}
    </Button>
    <Button
      variant="danger"
      loading={unassign.isPending}
      onclick={() => {
        if (unassigning) once(() => unassigning && unassign.mutate(unassigning))
      }}
    >
      {t('accr_unassign')}
    </Button>
  {/snippet}
</Dialog>

<!-- ---------------------------------------------------------------- preview, then run -->
<Dialog
  bind:open={runOpen}
  size="lg"
  title={t('accr_run_title')}
  description={t('accr_run_desc')}
  onOpenChange={(open) => {
    if (!open) runOpen = false
  }}
>
  <div class="form">
    <div class="pair">
      <Field label={t('accr_run_from')} required>
        {#snippet children(id)}
          <Input {id} type="date" bind:value={runFrom} />
        {/snippet}
      </Field>
      <Field label={t('accr_run_to')} required>
        {#snippet children(id)}
          <Input {id} type="date" bind:value={runTo} />
        {/snippet}
      </Field>
    </div>

    {#if !runRangeValid}
      <p class="hint">{t('accr_error_to_before_from')}</p>
    {:else if previewQuery.isLoading || previewQuery.isFetching}
      <div class="rows">
        {#each [1, 2, 3, 4] as n (n)}<Skeleton height="40px" />{/each}
      </div>
    {:else if preview}
      <div class="tiles">
        <StatTile size="md" label={t('accr_run_people')} value={formatCount(creditable.length, 999)} />
        <!--
          In time, not days, and deliberately so: one run covers everybody, and the people in it may
          sit on policies whose days are different lengths, so there is no single day this sum could
          honestly be divided by. Each row below *is* in days, because the server divided it by that
          person's own policy. The unit is on the tile rather than left to be inferred.
        -->
        <StatTile
          size="md"
          label={t('accr_run_total')}
          value={duration(preview.totalMinutes)}
          note={t('accr_run_total_note')}
        />
        <StatTile size="md" label={t('accr_run_skipped')} value={formatCount(preview.skipped.length, 999)} />
      </div>

      {#if preview.rows.length === 0}
        <EmptyState
          icon="check-check"
          compact
          title={t('accr_run_nothing')}
          description={t('accr_run_nothing_desc')}
        />
      {:else}
        <SectionLabel label={t('accr_run_rows')} count={preview.rows.length} sub />
        <div class="scroll">
          <ul class="plist">
            {#each preview.rows as row (row.personId + row.leaveTypeId)}
              <li class:done={row.alreadyAccrued}>
                <span class="pname">{row.displayName}</span>
                <span class="pdays num">
                  {days(row.days)}
                  {t('days', { count: row.days })}
                </span>
                <span class="sub ptype">{row.leaveTypeName}</span>
                <!-- The server's own words for why the number is what it is: it is arithmetic, not
                     a sentence this module could translate without recomputing it. -->
                <span class="sub preason">{row.reason}</span>
                {#if row.alreadyAccrued}
                  <Badge tone="grey">{t('accr_run_already')}</Badge>
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if preview.skipped.length > 0}
        <SectionLabel label={t('accr_run_skipped')} count={preview.skipped.length} sub />
        <ul class="plist">
          {#each preview.skipped.slice(0, HEAD) as row (row.personId)}
            <li>
              <span class="pname">{row.displayName}</span>
              <span class="sub preason">{row.reason}</span>
            </li>
          {/each}
          {#if preview.skipped.length > HEAD}
            <li class="sub">{t('accr_run_more', { count: preview.skipped.length - HEAD })}</li>
          {/if}
        </ul>
      {/if}

      {#if alreadyDone > 0}
        <p class="hint">{t('accr_run_idempotent', { count: alreadyDone })}</p>
      {/if}
      <p class="note warn">{t('accr_run_writes')}</p>
    {:else if previewQuery.isError}
      <EmptyState icon="triangle-alert" title={t('accr_preview_error')} description={t('accr_error_desc')}>
        {#snippet actions()}
          <Button variant="secondary" onclick={() => void previewQuery.refetch()}>{t('retry')}</Button>
        {/snippet}
      </EmptyState>
    {/if}
  </div>

  {#snippet footer()}
    <Button variant="secondary" onclick={() => (runOpen = false)} disabled={runAccrual.isPending}>
      {t('cancel')}
    </Button>
    <!--
      The run cannot be reached without the preview: it is disabled until `accrual.preview` has
      answered with something to credit, which is the whole reason that procedure exists.
    -->
    <Button
      loading={runAccrual.isPending}
      disabled={!manage || !preview || creditable.length === 0}
      onclick={() => once(() => runAccrual.mutate())}
    >
      {t('accr_run_credit', { count: creditable.length })}
    </Button>
  {/snippet}
</Dialog>

<style>
.rows {
  display: grid;
  gap: 4px;
}
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
  margin-block-end: 18px;
}

/* Notes, a table and a footnote in one section: one gap rather than a margin per element. */
.stack {
  display: grid;
  gap: 12px;
}

/* One grid for the header and every row, so the columns line up down the page. */
.table {
  width: 100%;
  --hr-accr-cols: minmax(150px, 1.4fr) minmax(120px, 1.2fr) minmax(110px, 1fr) 56px 32px;
}
/* The carry-forward table is the same anatomy with a narrower deadline column: it holds one chip,
   where the accrual table's third column holds a badge and a line of settings under it. */
.table.cf {
  --hr-accr-cols: minmax(150px, 1.4fr) minmax(110px, 1fr) minmax(100px, 0.9fr) 56px 32px;
}
.thead,
.trow {
  display: grid;
  grid-template-columns: var(--hr-accr-cols);
  gap: 10px;
  align-items: center;
  padding-inline: 10px;
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
  min-height: 52px;
  border-block-end: 1px solid var(--kern-border-hairline);
  border-radius: var(--kern-r-md);
}
.trow:hover {
  background: var(--kern-surface-raised);
}
.cell {
  min-width: 0;
}
.what {
  display: grid;
  gap: 2px;
}
.strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
  font-weight: 500;
  color: var(--kern-ink-900);
}
/* Muted with a colour, never opacity: opacity fades text against the page whatever token it names. */
.sub {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--kern-ink-500);
}
.chips {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.num {
  font-variant-numeric: tabular-nums;
}
.actions {
  display: flex;
  justify-content: flex-end;
  overflow: visible;
}
.danger {
  color: var(--kern-danger);
}
.warn-text {
  color: var(--kern-warning);
}

.ladder {
  display: grid;
  gap: 16px;
}
.rung {
  display: grid;
  gap: 2px;
  padding-inline-start: 10px;
  border-inline-start: 2px solid var(--kern-accent);
}
/* A rung nobody uses still belongs on the ladder — it is drawn quieter, not dropped, because the
   gap between two rungs is itself the thing an admin is reading. */
.rung.empty {
  border-inline-start-color: var(--kern-border);
}
.rlist {
  display: grid;
  gap: 2px;
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}
.rlist li {
  display: grid;
  /* The policy column carries a kind chip as well as the name now, so it is the wider of the two
     text columns rather than the narrower. */
  grid-template-columns: minmax(140px, 1.2fr) minmax(150px, 1.3fr) minmax(110px, 0.8fr) 32px;
  gap: 10px;
  align-items: center;
  min-height: 36px;
  min-width: 0;
  padding-inline: 8px;
  border-radius: var(--kern-r-md);
}
.rlist li:hover {
  background: var(--kern-surface-raised);
}
.rsubject {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.rpolicy {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.rname {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--kern-ink-700);
}
.rwhen {
  white-space: nowrap;
}

.hint {
  margin: 0;
  font-size: 12px;
  color: var(--kern-ink-500);
}
.hint.spaced {
  margin-block-start: 10px;
}
/* The reason a footer button is disabled sits beside it and takes the slack, so a long sentence
   pushes nothing off the end of the row. */
.problem {
  flex: 1;
  min-width: 0;
  text-wrap: pretty;
}
.note {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--kern-r-md2);
  background: var(--kern-info-tint);
  color: var(--kern-ink-700);
  font-size: 12.5px;
  line-height: 1.5;
}
.note.warn {
  background: var(--kern-warning-tint);
  color: var(--kern-warning);
}
.danger-note {
  background: var(--kern-danger-tint);
  color: var(--kern-danger);
}
.stale {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding-block: 6px;
  padding-inline: 12px 8px;
  border-radius: var(--kern-r-md);
  background: var(--kern-warning-tint);
  color: var(--kern-warning);
  font-size: 12.5px;
}
.body {
  margin: 0 0 4px;
  font-size: 13.5px;
}
.link {
  color: var(--kern-accent-text);
  text-decoration: underline;
}

.form {
  display: grid;
  gap: 14px;
}
.pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  align-items: start;
}
.beaten {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.tierbox {
  display: grid;
  gap: 4px;
}
.tiers {
  display: grid;
  gap: 8px;
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}
.tiers li {
  display: grid;
  grid-template-columns: 1fr 1fr 32px;
  gap: 10px;
  align-items: end;
}

.scroll {
  max-block-size: 300px;
  overflow-y: auto;
  overflow-x: auto;
}
.plist {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.plist li {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) 72px minmax(80px, 0.8fr) minmax(120px, 1.4fr) auto;
  gap: 10px;
  align-items: baseline;
  min-width: 0;
  padding-block: 4px;
  font-size: 13px;
}
/* A row already credited is still shown — that is the idempotence made visible — and it is drawn
   quieter with a colour rather than faded with opacity. */
.plist li.done .pname {
  color: var(--kern-ink-500);
}
.pname {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pdays {
  white-space: nowrap;
}
.ptype,
.preason {
  white-space: nowrap;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@media (max-width: 640px) {
  .table {
    --hr-accr-cols: minmax(140px, 1fr) minmax(100px, 0.9fr) 32px;
  }
  /* `.table.cf` outranks `.table` at any width, so the narrow layout has to be restated for it. */
  .table.cf {
    --hr-accr-cols: minmax(140px, 1fr) minmax(100px, 0.9fr) 32px;
  }
  /* The third and fourth columns of both tables go — the frequency or the deadline, and the
     assignment count. What a policy is called and what it is worth cannot. */
  .thead > :nth-child(3),
  .trow > :nth-child(3),
  .thead > :nth-child(4),
  .trow > :nth-child(4) {
    display: none;
  }
  /* Both lists stop being tables and become wrapped lines: the effective range and the server's
     arithmetic are the parts a narrow screen can lose without losing the answer. */
  .rlist li,
  .plist li {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    align-items: center;
  }
  .rwhen,
  .ptype,
  .preason {
    display: none;
  }
  .pair,
  .tiers li {
    grid-template-columns: 1fr;
  }
}
</style>
