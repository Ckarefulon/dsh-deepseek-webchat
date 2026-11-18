/**
 * Set up React and run the render checks.
 *
 * `test/render.test.mjs` is the one test that needs React, and React is not a
 * dependency of this package — the shell supplies it at runtime, and the publish
 * workflow installs nothing. So the render checks skip unless someone puts a
 * React where that test can find it, and this is how: install into `.tools/`
 * (git-ignored), then run the suite with it in place.
 *
 *   npm run check:render        # one-shot; leaves .tools/ behind
 *   rm -rf .tools               # to undo
 *
 * Nothing in the published package depends on this file; it exists so the
 * `ReferenceError` class of bug — a helper read before its `const`, which the
 * straight-line body of a component will happily compile and then throw on
 * first render — is caught here rather than in somebody's sidebar.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tools = join(root, '.tools')

// One install, every tool this repo's optional checks need.
//
// `--no-save` means pnpm/npm treat `.tools/` as a throwaway tree: a *second*
// install with a different package list prunes what the first one put there, so
// react and js-yaml have to go in together. Splitting them into per-check
// installs is what made the render checks disappear the moment the patch check
// installed its own parser.
const TOOLS = ['react@18', 'react-dom@18', 'js-yaml@4']

if (!existsSync(join(tools, 'node_modules', 'react', 'index.js'))) {
  mkdirSync(tools, { recursive: true })
  console.log('render-check: installing ' + TOOLS.join(', ') + ' into .tools/')
  // Driving npm's own entry point beats spawning the `npm` shim: on Windows that
  // shim is a `.cmd`, which Node refuses to spawn without a shell (EINVAL since
  // the CVE-2024-27980 fix), and a shell then has to survive a path with spaces,
  // parentheses-adjacent dashes and a drive letter — which this one does not.
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const command = existsSync(npmCli)
    ? { file: process.execPath, args: [npmCli] }
    : { file: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [], shell: process.platform === 'win32' }
  execFileSync(
    command.file,
    [...command.args, 'install', '--prefix', tools, '--no-save', '--no-audit', '--no-fund', ...TOOLS],
    { stdio: 'inherit', cwd: root, shell: command.shell === true },
  )
}

const skip = existsSync(join(tools, 'node_modules', 'react', 'index.js')) ? false : 'react is not installed'
if (skip !== false) {
  console.error('render-check: could not install react, so the render checks cannot run')
  process.exit(1)
}

// `--test` with the whole suite, not just the render file: the point of running
// it locally is to see the render checks pass *alongside* everything else.
execFileSync(
  process.execPath,
  ['--test'],
  { stdio: 'inherit', cwd: root },
)
