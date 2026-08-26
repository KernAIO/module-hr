/**
 * Every `icon="…"` name must exist in the design system's registry.
 *
 * An unregistered name renders a blank square and fails silently — nothing type-checks it, and
 * nothing throws. Lucide also renames icons between versions (`alert-triangle` became
 * `triangle-alert`), so a name that was right once quietly stops being right.
 *
 * A module ships its own screens, so it needs this as much as the app does: `icon="user-round"`
 * type-checked, linted and rendered nothing until somebody looked at the button.
 *
 *   node scripts/check-icons.mjs
 */
import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Where the names live depends on how `@kernhq/ui` is installed.
 *
 * The package publishes `dist` only, so CI reads the compiled registry; the umbrella workspace
 * links the source, and a freshly cloned checkout may not have built it yet. Importing the module
 * instead is not an option: it pulls in Svelte components, which plain node cannot load.
 */
const CANDIDATES = [
  'node_modules/@kernhq/ui/dist/icons/registry.js',
  'node_modules/@kernhq/ui/src/lib/icons/registry.ts',
]

let registrySource = null
let registryPath = null
for (const candidate of CANDIDATES) {
  try {
    registrySource = readFileSync(join(root, candidate), 'utf8')
    registryPath = candidate
    break
  } catch {
    // try the next one
  }
}
if (!registrySource) {
  console.error(`Cannot find the icon registry. Looked in:\n  ${CANDIDATES.join('\n  ')}`)
  process.exit(1)
}

const known = new Set([...registrySource.matchAll(/^\s+'?([a-z0-9-]+)'?:\s/gm)].map((match) => match[1]))
if (known.size < 20) {
  console.error(`Only ${known.size} icons found in ${registryPath} — its format has changed.`)
  process.exit(1)
}

/** `icon="x"` and `icon: 'x'` are the two ways a name reaches `<Icon>`; `name=` is too generic. */
const USES = [/icon="([a-z0-9-]+)"/g, /icon:\s*'([a-z0-9-]+)'/g, /<Icon\s+name="([a-z0-9-]+)"/g]

/**
 * A list of names offered as a choice — `const ICONS = ['bug', 'flag', …]` — reaches `<Icon>` too,
 * through a variable, so none of the patterns above see it. A picker built from such a list is
 * exactly where an unregistered name hides: it renders as one blank square among eleven good ones.
 * Any const whose name ends in ICONS is read as a list of icon names.
 */
const ICON_LISTS = /const\s+\w*ICONS\b[^=]*=\s*\[([^\]]*)\]/g
const QUOTED = /'([a-z0-9-]+)'/g

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else if (/\.(svelte|ts)$/.test(entry.name)) yield path
  }
}

const problems = []
for await (const file of files(join(root, 'src'))) {
  const source = readFileSync(file, 'utf8')
  for (const pattern of USES)
    for (const [, name] of source.matchAll(pattern))
      if (!known.has(name)) problems.push(`${file.slice(root.length + 1)}: ${name}`)
  for (const [, body] of source.matchAll(ICON_LISTS))
    for (const [, name] of body.matchAll(QUOTED))
      if (!known.has(name)) problems.push(`${file.slice(root.length + 1)}: ${name}`)
}

if (problems.length) {
  console.error('Icon names that are not in the registry (they render as a blank square):\n')
  for (const problem of [...new Set(problems)].sort()) console.error(`  ${problem}`)
  console.error(`\n${problems.length} use(s). Pick a name from @kernhq/ui's icons/registry.ts.`)
  process.exit(1)
}
console.log(`✓ every icon name resolves (${known.size} in the registry)`)
