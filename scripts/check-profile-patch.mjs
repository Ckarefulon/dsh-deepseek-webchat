/**
 * Validate a DSH profile patch file the way the loader must: YAML with the
 * `!!js` custom tag treated as an opaque scalar (DSH evaluates those itself,
 * after parsing). Every entry id is printed, so a restored patch can be
 * reviewed before it is trusted — which is exactly what you need after DSH's
 * crash dialog has replaced a full patch with a minimal one.
 *
 * Usage: node scripts/check-profile-patch.mjs <patch.yml>
 *
 * js-yaml is not a dependency of this repo. It is resolved from the DSH
 * installation instead (see resolveYaml), so this stays a dev-only tool with no
 * package.json footprint. Override with DSH_JS_YAML=/path/to/js-yaml if needed.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

/**
 * Find a js-yaml to parse with, preferring the caller's own resolution and
 * falling back to whatever the DSH profiles already have installed.
 * @returns the module namespace, or null when nothing usable was found.
 */
async function resolveYaml() {
  const explicit = process.env.DSH_JS_YAML
  if (explicit !== undefined) {
    const path = join(resolve(explicit), 'index.js')
    return existsSync(path) ? import(pathToFileURL(path).href) : null
  }
  // 1. Ordinary resolution: works when run from a directory with node_modules.
  try {
    return await import('js-yaml')
  } catch {}
  // 2. Any DSH profile's installed copy.
  const profiles = join(homedir(), '.dsh', 'profiles')
  if (existsSync(profiles)) {
    for (const name of readdirSync(profiles)) {
      const candidate = join(profiles, name, 'node_modules', 'js-yaml')
      if (!existsSync(candidate)) continue
      try {
        return await import(pathToFileURL(join(candidate, 'index.js')).href)
      } catch {}
    }
  }
  return null
}

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node scripts/check-profile-patch.mjs <patch.yml>')
  process.exit(2)
}

const yaml = await resolveYaml()
if (yaml === null) {
  console.log('  no js-yaml found. Install one, or set DSH_JS_YAML to a js-yaml directory.')
  console.log('  (a DSH profile normally has one at ~/.dsh/profiles/<name>/node_modules/js-yaml)')
  process.exit(2)
}

// `!!js` expressions are evaluated by DSH after parsing; here they stay opaque.
const jsTag = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (data) => ({ __js: data }),
})
const schema = yaml.DEFAULT_SCHEMA.extend([jsTag])

const path = resolve(file)
let text
try {
  text = readFileSync(path, 'utf8')
} catch (error) {
  console.log(`  cannot read ${path}: ${error.message}`)
  process.exit(1)
}

let doc
try {
  doc = yaml.load(text, { schema })
} catch (error) {
  console.log('  PARSE FAILED:', error.message)
  process.exit(1)
}

if (!Array.isArray(doc)) {
  console.log('  NOT A TOP-LEVEL ARRAY — DSH expects a list of patch entries')
  process.exit(1)
}

console.log(`  ${path}`)
console.log(`  ${text.length} bytes, ${text.split('\n').length} lines`)
console.log(`  parsed ok: ${doc.length} top-level entries`)

let inserts = 0
let malformed = 0
for (const [index, entry] of doc.entries()) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    console.log(`  [${index}] !! not an object: ${JSON.stringify(entry)}`)
    malformed += 1
    continue
  }
  const kind = entry.insert !== undefined
    ? 'insert'
    : entry.disabled !== undefined
      ? 'disable'
      : entry.remove !== undefined
        ? 'remove'
        : 'override'
  const label = entry.id ?? entry.name ?? ''
  const count = Array.isArray(entry.insert) ? entry.insert.length : 0
  if (kind === 'insert') inserts += count
  console.log(`  [${index}] ${kind.padEnd(9)} ${String(label).padEnd(34)}${count ? ` (+${count} rows)` : ''}`)
}

console.log(`\n  inserted rows total: ${inserts}`)
if (malformed > 0) {
  console.log(`  ${malformed} malformed entr${malformed === 1 ? 'y' : 'ies'}`)
  process.exit(1)
}
console.log('  structure: OK')
