<script lang="ts">
import {
  Badge,
  type BadgeTone,
  Button,
  EmptyState,
  formatCount,
  messageLocale,
  navigation,
  Page,
  PageHeader,
  SectionLabel,
  Skeleton,
  StatTile,
  session,
} from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getHrApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { canHr } from '../permissions.js'
import { hrKeys } from '../query.js'

/**
 * Where the company works.
 *
 * A table rather than cards: an office list is read down a column — which of these is in which
 * country, how many people, what time is it there — and cards make every one of those a scan across
 * the page instead of down it.
 *
 * The **current local time** is the reason this screen earns its place once there is more than one
 * office: it is the answer to "can I call Amsterdam now". The default office is marked because it is
 * where somebody with no assignment lands and where the resolution ladder bottoms out.
 */
const api = getHrApi()

const workspaceSlug = $derived(navigation.workspaceSlug)
const workspace = $derived(session.workspaces.find((w) => w.slug === workspaceSlug))
const workspaceId = $derived(workspace?.id ?? '')

const officesQuery = createQuery(() => ({
  queryKey: hrKeys.offices(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.offices.list({ workspaceId, includeArchived: false }),
}))
const offices = $derived(officesQuery.data ?? [])

const stats = $derived({
  countries: new Set(offices.map((o) => o.country)).size,
  people: offices.reduce((sum, o) => sum + o.headcount, 0),
  /** Two offices in one zone is one clock to think about; two zones is a scheduling problem. */
  timezones: new Set(offices.map((o) => o.timezone)).size,
})

/** Re-renders the clocks once a minute; an office list showing a stale time is worse than none. */
let tick = $state(0)
$effect(() => {
  const handle = setInterval(() => {
    tick++
  }, 60_000)
  return () => clearInterval(handle)
})

function localTime(timezone: string, _tick: number): string {
  void _tick
  try {
    // The office's zone, the reader's locale: `localTime` from @kernhq/ui cannot help here because
    // it formats in the reader's own zone, and the whole point of this column is somebody else's.
    // `messageLocale()` is what stops the clocks reading in Latin digits on a Persian screen.
    return new Intl.DateTimeFormat(messageLocale(), {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date())
  } catch {
    // An unknown zone must not take the page down with it.
    return '—'
  }
}

/** The country's own name, rather than a two-letter code nobody reads. */
function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(messageLocale(), { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

const kindLabel = (kind: string): string =>
  kind === 'head_office'
    ? t('office_kind_head_office')
    : kind === 'branch'
      ? t('office_kind_branch')
      : kind === 'site'
        ? t('office_kind_site')
        : kind === 'warehouse'
          ? t('office_kind_warehouse')
          : kind === 'store'
            ? t('office_kind_store')
            : t('office_kind_remote')

const kindTone = (kind: string): BadgeTone => (kind === 'remote' ? 'info' : 'grey')
</script>

<PageHeader
  crumbs={[{ label: workspace?.name ?? '' }, { label: t('offices_title') }]}
  title={t('offices_title')}
>
  {#snippet actions()}
    {#if canHr('officeManage')}
      <Button size="sm" variant="secondary" icon="settings" href={`/${workspaceSlug}/settings/hr/offices`}>
        {t('offices_manage')}
      </Button>
    {/if}
  {/snippet}
</PageHeader>

<Page>
  <!--
    No "Offices" tile. It said the same word and the same number as the section label directly
    below it, so the page opened with "Offices / Offices / Offices 2 / OFFICES 2" down the left
    edge. A tile has to add a fact the list does not already state: how many countries the company
    operates in, how many people those offices hold, and how many clocks you are working across.
  -->
  <div class="tiles">
    <StatTile
      size="md"
      label={t('offices_countries')}
      value={formatCount(stats.countries, Number.MAX_SAFE_INTEGER)}
    />
    <StatTile size="md" label={t('office_people')} value={formatCount(stats.people, Number.MAX_SAFE_INTEGER)} />
    <StatTile
      size="md"
      label={t('offices_timezones')}
      value={formatCount(stats.timezones, Number.MAX_SAFE_INTEGER)}
    />
  </div>

  <SectionLabel label={t('offices_title')} count={offices.length} />

  {#if officesQuery.isLoading}
    <div class="rows">
      {#each [1, 2, 3] as n (n)}<Skeleton height="48px" />{/each}
    </div>
  {:else if officesQuery.isError}
    <EmptyState icon="triangle-alert" title={t('offices_error')}>
      {#snippet actions()}
        <Button variant="secondary" onclick={() => void officesQuery.refetch()}>{t('retry')}</Button>
      {/snippet}
    </EmptyState>
  {:else if offices.length === 0}
    <EmptyState icon="building" title={t('offices_none')} description={t('offices_none_desc')} />
  {:else}
    <div class="table" role="table" aria-label={t('offices_title')}>
      <div class="thead" role="row">
        <span role="columnheader">{t('office')}</span>
        <span role="columnheader">{t('office_kind')}</span>
        <span role="columnheader">{t('office_country')}</span>
        <span role="columnheader">{t('office_people')}</span>
        <span role="columnheader">{t('local_time')}</span>
      </div>
      {#each offices as office (office.id)}
        <a
          class="trow"
          role="row"
          href={`/${workspaceSlug}/hr?officeId=${office.id}`}
          aria-label={`${office.name} — ${t('office_view_people')}`}
        >
          <span class="cell name" role="cell">
            {office.name}
            {#if office.isDefault}<Badge tone="accent">{t('office_default')}</Badge>{/if}
          </span>
          <span class="cell" role="cell"><Badge tone={kindTone(office.kind)}>{kindLabel(office.kind)}</Badge></span>
          <span class="cell muted" role="cell">{countryName(office.country)}</span>
          <span class="cell num" role="cell">{formatCount(office.headcount, Number.MAX_SAFE_INTEGER)}</span>
          <span class="cell num" role="cell" title={office.timezone}>{localTime(office.timezone, tick)}</span>
        </a>
      {/each}
    </div>
  {/if}
</Page>

<style>
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin-block-end: 20px;
}
.rows {
  display: grid;
  gap: 4px;
}

/* One grid for the header and every row, so the columns line up down the page. */
.table {
  --hr-office-cols: minmax(200px, 1.4fr) 130px minmax(120px, 0.8fr) 96px 104px;
  width: 100%;
}
.thead,
.trow {
  display: grid;
  grid-template-columns: var(--hr-office-cols);
  gap: 12px;
  align-items: center;
  padding-inline: 12px;
}
.thead {
  height: 34px;
  border-block-end: 1px solid var(--kern-border);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--kern-ink-500);
}
.trow {
  height: 48px;
  border-block-end: 1px solid var(--kern-border-hairline);
  text-decoration: none;
  color: inherit;
  border-radius: var(--kern-r-md);
}
.trow:hover {
  background: var(--kern-surface-raised);
}
.cell {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13.5px;
  font-weight: 500;
}
.muted {
  font-size: 13px;
  /* A colour, not opacity: opacity fades text against the page whatever token it names. */
  color: var(--kern-ink-500);
}
.num {
  font-size: 13px;
  color: var(--kern-ink-500);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 900px) {
  .table {
    --hr-office-cols: minmax(140px, 1.4fr) 110px 96px 88px;
  }
  /* The country column is the one a narrow screen can lose: the office name implies it. */
  .thead > :nth-child(3),
  .trow > :nth-child(3) {
    display: none;
  }
}
</style>
