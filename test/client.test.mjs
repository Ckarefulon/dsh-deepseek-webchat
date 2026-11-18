/**
 * Tests for the two things that are too easy to get silently wrong: which rows
 * a range covers, and which rows a turn contributes.
 *
 * Neither needs a DOM. The browser half is loaded the way the shell loads it —
 * through `window.__ModuleLoader__.load` — with `react` mocked to the one
 * function the module body touches at load time, so what is under test is the
 * shipped file, not a copy of it.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** Load `lib/client.js` and hand back the internals it exposes for testing. */
function loadClient() {
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  let registered
  const window = {
    __ModuleLoader__: {
      load: (entry) => { registered = entry },
    },
  }
  // The factory body only calls `require('react')` once, to bind `h`; no
  // component is rendered here.
  const require = () => () => undefined
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'navigator', 'document', 'localStorage', source)
  run(window, { language: 'zh-CN' }, { querySelector: () => null }, undefined)
  assert.equal(registered.id, 'dsh-deepseek-webchat')
  return registered.factory(require)
}

const client = loadClient()
const { spanOf, spanIds, groupTurns, fieldsFor, sameFields, oneLine, TURN_PRESETS } = client.__internals

test('a range is the same span whichever end is clicked first', () => {
  assert.deepEqual(spanOf(2, 6), [2, 6])
  assert.deepEqual(spanOf(6, 2), [2, 6])
  assert.deepEqual(spanOf(4, 4), [4, 4])
  assert.equal(spanOf(Number.NaN, 3), null)
})

test('a range resolves to row ids in log order', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
  assert.deepEqual(spanIds(rows, spanOf(3, 1)), ['b', 'c', 'd'])
})

test('a turn ends at the next human turn, not at a question answer', () => {
  const rows = [
    { id: '1:0', kind: 'user', turn: 1, text: 'first ask' },
    { id: '2:0', kind: 'assistant', turn: 1, text: 'working' },
    { id: '3:0', kind: 'question', turn: 1, text: 'which?' },
    { id: '4:0', kind: 'answer', turn: 1, text: 'that one' },
    { id: '5:0', kind: 'assistant', turn: 1, text: 'done' },
    { id: '6:0', kind: 'user', turn: 2, text: 'second ask' },
  ]
  const turns = groupTurns(rows)
  assert.equal(turns.length, 2)
  assert.equal(turns[0].rows.length, 5)
  assert.equal(turns[0].title, 'first ask')
  // The last assistant text of the turn, and only it, is the final output.
  assert.equal(turns[0].final.id, '5:0')
  assert.equal(turns[1].final, null)
})

test('rows logged before the first human turn are not a turn of their own', () => {
  const turns = groupTurns([
    { id: '0:0', kind: 'assistant', turn: 0, text: 'stray' },
    { id: '1:0', kind: 'user', turn: 1, text: 'ask' },
  ])
  assert.equal(turns.length, 1)
  assert.equal(turns[0].rows.length, 1)
})

test('an untouched turn reads the default, an edited one keeps its own', () => {
  const defaults = TURN_PRESETS.standard
  const overrides = new Map([['t2', ['input', 'final', 'process', 'detail']]])
  assert.equal(fieldsFor(defaults, overrides, 't1'), defaults)
  assert.deepEqual(fieldsFor(defaults, overrides, 't2'), ['input', 'final', 'process', 'detail'])
  // Changing the default moves every untouched turn at once, which is what
  // makes 「应用到全部」 unnecessary.
  const next = TURN_PRESETS.minimal
  assert.equal(fieldsFor(next, overrides, 't1'), next)
  assert.equal(fieldsFor(next, overrides, 't3'), next)
  assert.deepEqual(fieldsFor(next, overrides, 't2'), ['input', 'final', 'process', 'detail'])
})

test('the presets are ordered as sets, and equality is order-independent', () => {
  assert.deepEqual(TURN_PRESETS.minimal, ['input', 'final'])
  assert.deepEqual(TURN_PRESETS.standard, ['input', 'final', 'process'])
  assert.deepEqual(TURN_PRESETS.full, ['input', 'final', 'process', 'detail'])
  assert.equal(sameFields(['final', 'input'], ['input', 'final']), true)
  assert.equal(sameFields(['input'], ['input', 'final']), false)
})

test('a turn header takes one clipped line', () => {
  assert.equal(oneLine('  first line\nsecond'), 'first line')
  assert.equal(oneLine('   \n  second'), 'second')
  assert.equal(oneLine('x'.repeat(80)).length, 61)
})
