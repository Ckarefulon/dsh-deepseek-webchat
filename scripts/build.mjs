/**
 * Copy `src/` to `lib/`, byte for byte.
 *
 * The plugin is plain JavaScript ESM, so there is nothing to transpile — but a
 * git-hosted DSH plugin must not need a build step on install, and a
 * `prepare` script is exactly the thing pnpm blocks behind `allowBuilds`. So
 * `lib/` is committed to the repository, and this script exists only so a
 * source edit can be republished in one command:
 *
 *   npm run build && git add -A && git commit -m "..." && git push
 *
 * `npm test` checks that the committed `lib/` still matches `src/`, which is
 * what keeps the two from drifting apart.
 *
 * ## Why the output layout is flat
 *
 * `src/client/index.js` becomes `lib/client.js`, not `lib/client/index.js`.
 * This is not cosmetic. DSH resolves a package's browser half by joining the
 * manifest's `exports["./client"]` onto the package root and reading it as an
 * **exact file path** — there is no extension or directory-index fallback
 * (`clientExportOf` in @deepseek-ai/dsh-client-modules). A manifest pointing at
 * `./lib/client.js` while the build writes `./lib/client/index.js` makes the
 * client module registry throw `MissingClientBundleError` during startup, which
 * aborts the whole Host boot: DSH does not open at all.
 *
 * Every package DSH ships uses the flat form (`./lib/client.js`), so this
 * matches the ecosystem as well as the loader.
 */

import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(root, 'src')
const target = join(root, 'lib')

/**
 * Source file → published file, relative to their trees.
 *
 * The mapping is explicit rather than a directory copy precisely because the
 * two trees have different shapes; a recursive copy would silently reintroduce
 * `lib/client/index.js`.
 */
export const OUTPUTS = [
  { from: 'index.js', to: 'index.js' },
  { from: join('client', 'index.js'), to: 'client.js' },
]

if (!existsSync(source)) {
  console.error(`build: no source directory at ${source}`)
  process.exit(1)
}

for (const { from } of OUTPUTS) {
  const file = join(source, from)
  if (statSync(file, { throwIfNoEntry: false })?.isFile() !== true) {
    console.error(`build: missing source file ${file}`)
    process.exit(1)
  }
}

// Replace rather than merge, so a file deleted from src/ cannot linger in lib/.
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
for (const { from, to } of OUTPUTS) {
  cpSync(join(source, from), join(target, to))
}

console.log(`build: copied src/ -> lib/ (${root})`)
for (const { from, to } of OUTPUTS) console.log(`  src/${from} -> lib/${to}`)
