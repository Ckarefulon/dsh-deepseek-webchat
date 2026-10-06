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
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(root, 'src')
const target = join(root, 'lib')

if (!existsSync(source)) {
  console.error(`build: no source directory at ${source}`)
  process.exit(1)
}

// Replace rather than merge, so a file deleted from src/ cannot linger in lib/.
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
cpSync(source, target, { recursive: true })

console.log(`build: copied src/ -> lib/ (${root})`)
