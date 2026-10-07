/**
 * Prove that @deepseek-ai/dsh-client-modules can compose one package's browser
 * half, **without restarting DSH to find out**.
 *
 * `resolveMeta()` joins `exports["./client"]` onto the package root and calls
 * `statSync` on the result — with no extension completion and no directory-index
 * fallback. A missing file throws `MissingClientBundleError`, and because
 * `modules` is a required plugin the whole Host boot aborts: DSH shows
 * "The application could not start or stopped unexpectedly" and never opens.
 *
 * This replicates that resolution verbatim, plus the neighbouring manifest
 * checks, so the failure is reproducible before a restart rather than after one.
 *
 * Usage:
 *   node scripts/check-client-bundle.mjs <packageRoot>
 *   node scripts/check-client-bundle.mjs .            # this repo
 *
 * Exit code 0 when client-modules would compose the package, 1 when it would
 * abort startup.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const arg = process.argv[2]
if (arg === undefined) {
  console.error('usage: node scripts/check-client-bundle.mjs <packageRoot>')
  process.exit(2)
}

const pkgRoot = resolve(arg)
const pkgPath = join(pkgRoot, 'package.json')

let pkg
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
} catch (error) {
  console.log(`  cannot read ${pkgPath}: ${error.message}`)
  process.exit(1)
}

// --- parseDshClient(): a package without dsh.client is not a graph row at all.
const decl = pkg.dsh?.client
if (decl === undefined) {
  console.log(`  ${pkg.name}: no dsh.client declaration, so client-modules skips it`)
  process.exit(0)
}
if (typeof decl.platform !== 'string') {
  console.log('  FAIL: dsh.client.platform must be a string')
  process.exit(1)
}
if (decl.platform !== 'web') {
  console.log(`  ${pkg.name}: platform is "${decl.platform}", not "web"; client-modules skips it`)
  process.exit(0)
}

// --- clientExportOf(): the path is read verbatim; no defaulting, no guessing.
const client = pkg.exports?.['./client']
if (client === undefined) {
  console.log('  FAIL: declares dsh.client but exports no "./client"')
  process.exit(1)
}
const rel = typeof client === 'string' ? client : client.default
if (typeof rel !== 'string') {
  console.log('  FAIL: exports["./client"] must name a file')
  process.exit(1)
}

// --- the exact line that aborts the boot: join, then statSync, nothing else.
const clientPath = join(dirname(pkgPath), rel)
const st = statSync(clientPath, { throwIfNoEntry: false })
if (st?.isFile() !== true) {
  console.log('  RESULT: MissingClientBundleError — DSH would abort startup')
  console.log('  declared:', rel)
  console.log('  resolved:', clientPath)
  console.log('  This is the whole-file path; extension completion and directory')
  console.log('  indexes are NOT tried. Ship the exact file the manifest names.')
  process.exit(1)
}

const bundle = readFileSync(clientPath, 'utf8')
const patch = pkg.dsh?.bundle?.patch
const patchOk = typeof patch !== 'string' || existsSync(join(pkgRoot, patch))

// The loader passes `require` only — no `module` — so the factory must declare
// its own, or the browser half dies with "module is not defined" at load time.
const declaresModule = /(?:const|let|var)\s+module\s*=\s*\{\s*exports\s*:\s*\{\s*\}\s*\}/.test(bundle)
const returnsExports = /return module\.exports/.test(bundle)
const registersId = bundle.includes(`id: '${pkg.name}'`) || bundle.includes(`id: "${pkg.name}"`)

console.log('  packageName    :', pkg.name)
console.log('  version        :', pkg.version)
console.log('  clientPath     :', clientPath)
console.log('  size           :', `${st.size} bytes`)
console.log('  dsh.client     :', JSON.stringify({ platform: decl.platform, inject: decl.inject ?? [] }))
console.log('  bundle patch   :', patch, patchOk ? '(present)' : '(MISSING)')
console.log('  registers id   :', registersId)
console.log('  declares module:', declaresModule)
console.log('  returns exports:', returnsExports)
console.log('')

const problems = []
if (!patchOk) problems.push('dsh.bundle.patch points at a file that does not exist')
if (!declaresModule) problems.push('bundle does not declare `var module = { exports: {} }` (the loader passes require only)')
if (!returnsExports) problems.push('bundle does not `return module.exports`')
if (!registersId) problems.push(`bundle does not register id ${pkg.name}`)

if (problems.length > 0) {
  console.log('  RESULT: composes, but the browser half would misbehave:')
  for (const problem of problems) console.log('    -', problem)
  process.exit(1)
}

console.log('  RESULT: client-modules composes this package without MissingClientBundleError')
