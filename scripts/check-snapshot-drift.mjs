#!/usr/bin/env node
/**
 * Do `schema.ts`, the newest drizzle snapshot and the catalogue the migrations actually build all
 * describe the same indexes?
 *
 * There are three artefacts and `pnpm db:generate` only ever compares two of them: it diffs
 * `schema.ts` against the newest snapshot. Seven of the eight migrations here create indexes by
 * hand — 57 of them — and generate has never compared one to a database. So an index that goes
 * into a `.sql` file and into neither of the other two leaves that pair agreeing with each other,
 * and generate stays silent. The consequence is not cosmetic: the day somebody adds that index to
 * `schema.ts`, generate emits `CREATE INDEX` with no `IF NOT EXISTS`, and every instance that
 * already ran the hand-written migration takes a 42P07 that aborts the whole upgrade transaction.
 * The mirror image is worse: delete a `uniqueIndex` from `schema.ts` and generate proposes
 * `DROP INDEX`, which quietly hands back an invariant the database was enforcing.
 *
 * The suite cannot catch either even in principle. Every integration run builds a fresh scratch
 * database and applies the whole folder to it once, so a duplicate `CREATE INDEX` is never
 * attempted; the collision only ever bites a database that already ran the earlier migration.
 *
 * So this closes both edges of the triangle:
 *
 *   schema.ts <-> snapshot   `drizzle-kit generate` into a throwaway copy of `migrations/`.
 *                            Anything it would write is drift, in whichever direction, and the
 *                            file it writes is the report. Needs no database.
 *
 *   snapshot <-> database    Apply every migration to a scratch database, then for each index the
 *                            snapshot declares ask Postgres to *build the index the snapshot
 *                            describes* and compare `pg_get_indexdef` of the two. Building it is
 *                            what makes the comparison exact: both strings come out of the same
 *                            deparser, so column list, expressions, sort direction, nulls
 *                            ordering, partial predicate, storage parameters, access method,
 *                            uniqueness and INCLUDE columns are all compared without this script
 *                            having to know how Postgres spells any of them.
 *
 * What the second edge does not compare, because Postgres does not record it:
 *
 *   * `concurrently`. It is how an index was built, not a property of the index; afterwards the
 *     two are indistinguishable. The first edge still compares it against `schema.ts`.
 *   * sort direction and nulls ordering under an access method that cannot order (gin, gist).
 *     There is nothing to order, so `pg_indexam_has_property(..., 'can_order')` is false and the
 *     snapshot's `asc`/`nulls` for those columns are not rendered into the probe either.
 *
 * The scope of each edge differs and it is worth being exact about which. The first compares
 * everything drizzle models — tables, columns, defaults, constraints, policies, the lot — because
 * drizzle does the comparing. The second compares indexes in `mod_hr` and nothing else: a column
 * default or an RLS policy a hand-written migration invented is not looked for here, and would go
 * unreported. Say so rather than letting the next reader assume the second edge is as wide as the
 * first.
 *
 * A snapshot field this script cannot reproduce fails the check by name (KNOWN_* below) instead of
 * being skipped, which is what stops this header drifting back into a claim nobody kept.
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDir = join(root, 'migrations')
const BASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const CI = Boolean(process.env.CI)

/**
 * Every key the snapshot's `indexes` section is known to carry. An unknown one means drizzle
 * started modelling something this script cannot render into its probe, so it would be compared
 * as if it were absent — silently, which is the failure this whole file exists to prevent. Fail
 * and name it instead.
 */
const KNOWN_INDEX_KEYS = new Set(['name', 'columns', 'isUnique', 'concurrently', 'method', 'where', 'with'])
const KNOWN_COLUMN_KEYS = new Set(['expression', 'isExpression', 'asc', 'nulls', 'opclass'])

/**
 * What the database has that the snapshot cannot describe, and why. A predicate here is a licence
 * to differ, so it names what it exempts as narrowly as it can: an entry that matched everything
 * would turn this check off without anybody noticing.
 */
const ALLOWED = [
  {
    label: 'exclusion constraint',
    reason:
      'EXCLUDE ... USING gist — drizzle-orm has no exclusion-constraint builder at all, so these ' +
      'live only in the hand-written migrations (0001, 0004, 0006).',
    matches: (ix) => ix.constraintType === 'x',
  },
  {
    label: 'attached partition copy',
    reason:
      'An index on a punch partition that Postgres attached to a partitioned index on the ' +
      '`punches` parent. The parent is the only thing declared and it is compared in full; the ' +
      'copies are Postgres keeping its own promise about it. An index created on one partition ' +
      'directly has nothing to be attached to, so it is not this and is compared like any other.',
    matches: (ix) => ix.tableIsPartition && ix.hasParentIndex,
  },
  {
    label: 'primary key',
    reason:
      'Primary-key index. The snapshot carries primary keys in the table/column entries rather ' +
      'than in `indexes`, so comparing them here would report a difference that is not one.',
    matches: (ix) => ix.isPrimary,
  },
]

/** The one drizzle diffs `schema.ts` against, so the only one `db:generate` can be held to. */
function newestSnapshot() {
  const file = readdirSync(join(migrationsDir, 'meta'))
    .filter((f) => f.endsWith('_snapshot.json'))
    .sort()
    .at(-1)
  return {
    file: join('migrations', 'meta', file),
    snapshot: JSON.parse(readFileSync(join(migrationsDir, 'meta', file), 'utf8')),
  }
}

function snapshotIndexes(snapshot) {
  const out = new Map()
  const unmodelled = []
  for (const table of Object.values(snapshot.tables)) {
    for (const ix of Object.values(table.indexes ?? {})) {
      for (const key of Object.keys(ix)) {
        if (!KNOWN_INDEX_KEYS.has(key)) unmodelled.push(`${ix.name}.${key}`)
      }
      for (const c of ix.columns) {
        for (const key of Object.keys(c)) {
          if (!KNOWN_COLUMN_KEYS.has(key)) unmodelled.push(`${ix.name}.columns[].${key}`)
        }
      }
      out.set(ix.name, {
        name: ix.name,
        schema: table.schema,
        table: table.name,
        isUnique: Boolean(ix.isUnique),
        concurrently: Boolean(ix.concurrently),
        method: ix.method ?? 'btree',
        where: ix.where,
        with: ix.with ?? {},
        columns: ix.columns,
      })
    }
  }
  return { declared: out, unmodelled }
}

// ---------------------------------------------------------------------------------------------
// Edge one: schema.ts against the newest snapshot, by the same tool that will be asked later.
// ---------------------------------------------------------------------------------------------

/**
 * `drizzle-kit generate` refuses `--config` alongside any other flag, so the flags have to repeat
 * what the config says. Read them out of the config rather than duplicating them, or the day
 * somebody moves `schema.ts` this check keeps passing against a file nobody edits any more.
 */
function drizzleConfig() {
  const path = join(root, 'drizzle.config.ts')
  const text = readFileSync(path, 'utf8')
  const read = (key) => new RegExp(`\\b${key}\\s*:\\s*'([^']+)'`).exec(text)?.[1]
  const cfg = { dialect: read('dialect'), schema: read('schema'), out: read('out') }
  for (const [key, value] of Object.entries(cfg)) {
    if (!value) {
      throw new Error(
        `drizzle.config.ts no longer declares \`${key}\` as a plain string. This check reads it so ` +
          'it generates against exactly what `pnpm db:generate` does; teach it the new shape rather ' +
          'than letting it check a file nobody edits.',
      )
    }
  }
  if (resolve(root, cfg.out) !== resolve(migrationsDir)) {
    throw new Error(
      `drizzle.config.ts writes migrations to ${cfg.out}, and this check compares ${migrationsDir}.`,
    )
  }
  return cfg
}

function schemaVsSnapshot(file) {
  const cfg = drizzleConfig()
  const bin = join(root, 'node_modules', '.bin', 'drizzle-kit')
  if (!existsSync(bin)) {
    throw new Error(`no drizzle-kit at ${bin} — install dependencies before running lint.`)
  }

  // Inside node_modules so it is already ignored, and a path `drizzle-kit` can take: it prefixes
  // `./` to whatever `--out` it is given, which turns an absolute path into one that does not exist.
  const scratch = join(root, 'node_modules', '.cache', `snapshot-drift-${randomBytes(6).toString('hex')}`)
  mkdirSync(dirname(scratch), { recursive: true })
  cpSync(migrationsDir, scratch, { recursive: true })
  try {
    const before = new Set(readdirSync(scratch).filter((f) => f.endsWith('.sql')))
    const run = spawnSync(
      bin,
      ['generate', '--dialect', cfg.dialect, '--schema', cfg.schema, '--out', relative(root, scratch)],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    if (run.status !== 0) {
      throw new Error(
        `drizzle-kit generate failed (exit ${run.status}).\n${run.stdout ?? ''}\n${run.stderr ?? ''}`,
      )
    }
    const written = readdirSync(scratch)
      .filter((f) => f.endsWith('.sql') && !before.has(f))
      .sort()
    // Exit 0 is not evidence of agreement. Anything drizzle-kit cannot infer it asks about — a
    // renamed column or table, most often — and with no terminal to ask on it throws inside the
    // prompt and *still exits 0*, having written nothing. Silence then reads exactly like a clean
    // run, which is the failure this whole file exists to break. So a clean run has to say so in
    // words: rename `country` to `country_code` in schema.ts and this is the branch that fires.
    if (written.length === 0 && !/No schema changes/.test(run.stdout ?? '')) {
      throw new Error(
        'drizzle-kit generate wrote no migration and did not report "No schema changes", so ' +
          'nothing here compared schema.ts to the snapshot. It asks about anything it cannot ' +
          'infer — a rename, usually — and dies at exit 0 when there is no terminal to ask on. ' +
          `Run \`pnpm db:generate\` by hand and answer it.\n${(run.stderr ?? '').trim().slice(0, 800)}`,
      )
    }
    return written.map((f) => {
      const body = readFileSync(join(scratch, f), 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '' && !line.startsWith('--> statement-breakpoint'))
        .map((line) => `      ${line}`)
        .join('\n')
      return (
        `${cfg.schema} and ${file} disagree — db:generate would write a migration:\n${body}\n` +
        '      Nothing has run that. If the index already exists because a hand-written migration\n' +
        '      creates it, move the entry into the snapshot by hand and delete the generated\n' +
        '      migration: drizzle emits no IF NOT EXISTS, so re-creating it takes a 42P07 that\n' +
        '      aborts the whole upgrade transaction on every instance that ran the original. If it\n' +
        '      is a DROP, the snapshot still claims an invariant schema.ts stopped declaring.'
      )
    })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------------------------
// Edge two: the newest snapshot against the catalogue the migrations build.
// ---------------------------------------------------------------------------------------------

const CATALOGUE = `
  select i.relname                                    as name,
         t.relname                                    as table_name,
         ix.indisunique                               as is_unique,
         ix.indisprimary                              as is_primary,
         t.relispartition                             as table_is_partition,
         con.contype                                  as constraint_type,
         (h.inhparent is not null)                    as has_parent_index,
         pg_get_indexdef(ix.indexrelid)               as def
    from pg_index ix
    join pg_class i      on i.oid = ix.indexrelid
    join pg_class t      on t.oid = ix.indrelid
    join pg_namespace n  on n.oid = t.relnamespace
    left join pg_constraint con on con.conindid = ix.indexrelid
    left join pg_inherits h     on h.inhrelid   = ix.indexrelid
   where n.nspname = 'mod_hr'
   order by i.relname
`

/**
 * `CREATE INDEX` on a partitioned table cascades to every partition; `ONLY` builds the parent
 * alone, which is all a deparse needs. Postgres prints the parent's own definition with `ON ONLY`
 * either way, so the two sides still line up.
 */
const RELATIONS = `select relname, relkind from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'mod_hr' and relkind in ('r', 'p')`

const CAN_ORDER = `select amname, pg_indexam_has_property(oid, 'can_order') as can_order from pg_am`

/** Postgres prints the name unquoted here, so drop it and compare everything either side of it. */
const DEF = /^(CREATE (?:UNIQUE )?INDEX) (\S+) (ON .*)$/s
function shapeOf(def) {
  const m = DEF.exec(def)
  if (!m) throw new Error(`cannot read an index definition this check has to compare: ${def}`)
  return `${m[1]} ${m[3]}`
}

/** The `CREATE INDEX` the snapshot describes, for Postgres to normalise and hand back. */
function probeSql(ix, probeName, isPartitioned, canOrder) {
  const columns = ix.columns.map((c) => {
    let text = c.isExpression ? `(${c.expression})` : `"${c.expression}"`
    if (c.opclass) text += ` ${c.opclass}`
    // Rendered only where an ordering exists to compare: gin and gist reject it outright, and the
    // snapshot's asc/nulls for those columns describe nothing Postgres will record.
    if (canOrder) {
      text += ` ${c.asc === false ? 'desc' : 'asc'} nulls ${c.nulls === 'first' ? 'first' : 'last'}`
    }
    return text
  })
  const storage = Object.entries(ix.with ?? {})
  return [
    `create ${ix.isUnique ? 'unique ' : ''}index "${probeName}"`,
    `on ${isPartitioned ? 'only ' : ''}"${ix.schema}"."${ix.table}"`,
    `using ${ix.method} (${columns.join(', ')})`,
    storage.length > 0 ? `with (${storage.map(([k, v]) => `${k} = ${v}`).join(', ')})` : '',
    ix.where ? `where ${ix.where}` : '',
  ]
    .filter(Boolean)
    .join(' ')
}

async function withScratchDatabase(fn) {
  const dbName = `kern_hr_drift_${randomBytes(6).toString('hex')}`
  const admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`create database "${dbName}"`)
  await admin.end()

  const url = new URL(BASE_URL)
  url.pathname = `/${dbName}`
  const client = new pg.Client({ connectionString: url.toString() })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end().catch(() => undefined)
    const dropper = new pg.Client({ connectionString: BASE_URL })
    await dropper.connect()
    await dropper.query(`drop database if exists "${dbName}" with (force)`).catch(() => undefined)
    await dropper.end()
  }
}

async function applyMigrations(client) {
  const journal = JSON.parse(readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf8'))
  for (const entry of journal.entries.sort((a, b) => a.idx - b.idx)) {
    const sql = readFileSync(join(migrationsDir, `${entry.tag}.sql`), 'utf8')
    // `--> statement-breakpoint` is a SQL comment, so the file runs as one simple query. That is
    // not how drizzle applies it, but the catalogue it leaves behind is the same.
    await client.query(sql)
  }
}

/**
 * Build each declared index beside the real one and read back what Postgres made of it. All of it
 * inside one transaction that is rolled back: the scratch database is thrown away regardless, but
 * a probe that survived would be indistinguishable from an index a migration created.
 */
async function normaliseDeclared(client, wanted) {
  const relkind = new Map((await client.query(RELATIONS)).rows.map((r) => [r.relname, r.relkind]))
  const canOrder = new Map((await client.query(CAN_ORDER)).rows.map((r) => [r.amname, r.can_order]))
  const shapes = new Map()
  const problems = []

  await client.query('begin')
  try {
    for (const [n, ix] of wanted.entries()) {
      const probeName = `hr_drift_probe_${n}`
      const sql = probeSql(ix, probeName, relkind.get(ix.table) === 'p', canOrder.get(ix.method) === true)
      await client.query('savepoint probe')
      try {
        await client.query(sql)
        const { rows } = await client.query('select pg_get_indexdef($1::regclass) as def', [
          `mod_hr."${probeName}"`,
        ])
        shapes.set(ix.name, shapeOf(rows[0].def))
        await client.query('release savepoint probe')
      } catch (err) {
        await client.query('rollback to savepoint probe')
        problems.push(
          `${ix.name}: the snapshot describes an index Postgres will not build — ${err.message}\n` +
            `      ${sql}`,
        )
      }
    }
  } finally {
    await client.query('rollback')
  }
  return { shapes, problems }
}

function summariseExempt(exempt) {
  return `Exempt: ${ALLOWED.map((rule) => `${exempt.get(rule) ?? 0}x ${rule.label}`).join(', ')}.`
}

async function snapshotVsDatabase(file, declared) {
  return await withScratchDatabase(async (client) => {
    await applyMigrations(client)
    const catalogue = (await client.query(CATALOGUE)).rows

    const problems = []
    /** rule -> how many catalogue entries it excused, so a rule that excuses nothing is visible. */
    const exempt = new Map()
    const matched = []
    const seen = new Set()

    for (const row of catalogue) {
      const ix = {
        name: row.name,
        tableName: row.table_name,
        isPrimary: row.is_primary,
        tableIsPartition: row.table_is_partition,
        hasParentIndex: row.has_parent_index,
        constraintType: row.constraint_type,
        def: row.def,
      }
      const allowed = ALLOWED.find((rule) => rule.matches(ix))
      if (allowed) {
        exempt.set(allowed, (exempt.get(allowed) ?? 0) + 1)
        continue
      }
      seen.add(ix.name)
      const want = declared.get(ix.name)
      if (!want) {
        problems.push(
          `${ix.name} on mod_hr.${ix.tableName} exists in the database and in no snapshot.\n` +
            `      ${ix.def}\n` +
            `      Declare it in src/server/schema.ts, then run db:generate, then move the index\n` +
            `      entry it writes into ${file} and delete the migration it wrote.\n` +
            `      Do not keep that migration: it creates an index every already-upgraded instance\n` +
            `      has, and drizzle does not emit IF NOT EXISTS, so it fails with 42P07 and aborts\n` +
            `      the whole upgrade transaction.`,
        )
        continue
      }
      matched.push({ want, ix })
    }

    for (const name of declared.keys()) {
      if (!seen.has(name)) problems.push(`${name} is in ${file} and the migrations never create it.`)
    }

    const { shapes, problems: probeProblems } = await normaliseDeclared(
      client,
      matched.map((m) => m.want),
    )
    problems.push(...probeProblems)

    let partial = 0
    let ordered = 0
    for (const { want, ix } of matched) {
      const declaredShape = shapes.get(want.name)
      if (declaredShape === undefined) continue
      const builtShape = shapeOf(ix.def)
      if (declaredShape !== builtShape) {
        problems.push(
          `${ix.name} is not the index ${file} describes.\n` +
            `      migrations build: ${builtShape}\n` +
            `      snapshot says:    ${declaredShape}`,
        )
        continue
      }
      if (/ WHERE /.test(builtShape)) partial += 1
      if (/ (DESC|NULLS FIRST)\b/.test(builtShape)) ordered += 1
    }

    const coverage =
      `${seen.size} index(es) compared, ${partial} of them partial and ${ordered} with a ` +
      'non-default sort order'
    return { problems, summary: `${coverage}. ${summariseExempt(exempt)}` }
  })
}

async function reachable() {
  const client = new pg.Client({ connectionString: BASE_URL, connectionTimeoutMillis: 3000 })
  try {
    await client.connect()
    await client.end()
    return true
  } catch (err) {
    await client.end().catch(() => undefined)
    return err
  }
}

async function main() {
  const { file, snapshot } = newestSnapshot()
  const { declared, unmodelled } = snapshotIndexes(snapshot)

  const problems = []
  if (unmodelled.length > 0) {
    problems.push(
      `${file} models index properties this check cannot rebuild: ${unmodelled.join(', ')}.\n` +
        '      They would be compared as if they were absent, which is the silence this check\n' +
        '      exists to break. Render them in probeSql and add them to KNOWN_INDEX_KEYS /\n' +
        '      KNOWN_COLUMN_KEYS, or say here why Postgres cannot record them.',
    )
  }

  // Each half reports what it found rather than throwing it. A half that cannot run at all is a
  // finding too, and a `throw` here would take the other half's findings down with it — the run
  // that taught us this reported a drizzle-kit crash and swallowed the snapshot problem above it.
  try {
    problems.push(...schemaVsSnapshot(file))
  } catch (err) {
    problems.push(`schema.ts could not be compared to ${file}: ${err.message}`)
  }

  let summary = ''
  let databaseRan = false
  const ok = await reachable()
  if (ok === true) {
    try {
      const result = await snapshotVsDatabase(file, declared)
      problems.push(...result.problems)
      summary = result.summary
      databaseRan = true
    } catch (err) {
      problems.push(`${file} could not be compared to what the migrations build: ${err.message}`)
      summary = 'Snapshot vs database did not finish.'
    }
  } else {
    const message = `no database at ${BASE_URL} (${ok.message})`
    if (CI) {
      console.error(
        `check-snapshot-drift: ${message}\nCI must not skip this check — start Postgres for the job.`,
      )
      process.exit(1)
    }
    summary =
      `Snapshot vs database SKIPPED: ${message}. Nothing compared the snapshot to what the ` +
      'migrations build. Start Postgres, or set DATABASE_URL, to run that half.'
  }

  if (problems.length > 0) {
    // Name the artefacts that were actually read. With the database half skipped, "and the
    // migrations do not agree" claims a comparison nothing performed.
    const compared = databaseRan ? `schema.ts, ${file} and the migrations` : `schema.ts and ${file}`
    console.error(`check-snapshot-drift: ${compared} do not agree.\n`)
    for (const p of problems) console.error(`  - ${p}`)
    console.error(`\n  ${summary}`)
    process.exit(1)
  }

  // Only claim the half that ran. A green line reading "N index(es) are what the migrations build"
  // above a line saying the database was skipped is how a check gets believed for work it did not do.
  const headline = `${drizzleConfig().schema} matches ${file} — drizzle-kit generate writes nothing`
  console.log(
    databaseRan
      ? `check-snapshot-drift: ${headline}, and the migrations build exactly the ${declared.size} ` +
          `index(es) it declares. ${summary}`
      : `check-snapshot-drift: ${headline}. ${summary}`,
  )
}

main().catch((err) => {
  console.error(`check-snapshot-drift: ${err.stack ?? err}`)
  process.exit(1)
})
