/**
 * Regression tests built on a real session's rows.
 *
 * Every other test in this package runs on a hand-written fixture: small, tidy,
 * and written by whoever wrote the code under test. That is exactly why three
 * bugs shipped in 0.6.0 while the suite was green:
 *
 *   1. `groupTurns` skipped every row, because the host started sending
 *      `turn: null` for rows before the first turn and the guard tested for `0`
 *      after coercing with `typeof`. The turn view came up permanently empty.
 *   2. A turn's 详细内容 box was disabled while that turn had no detail rows, and
 *      detail rows only arrived if the box was ticked. Deadlock.
 *   3. The box's checked state was derived from the selection rather than from
 *      the turn's choice, so a kind with no fetched rows could never be turned
 *      on — React reverted the click on the next render.
 *
 * Each has a test here, against the real row shapes that produced it.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)

/** Load the browser half without a DOM; only its pure helpers are used here. */
function loadClient() {
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  let registered
  globalThis.window = {
    __ModuleLoader__: { load: (entry) => { registered = entry } },
    localStorage: { getItem: () => null, setItem: () => {} },
  }
  const require = (name) => {
    if (name === 'react') return { createElement: () => null }
    throw new Error('unexpected require: ' + name)
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'navigator', 'document', 'matchMedia', source)
  run(
    globalThis.window,
    { language: 'zh-CN' },
    { querySelector: () => null },
    () => ({ matches: false }),
  )
  return registered.factory(require)
}

const client = loadClient()
const { groupTurns, fieldIds, turnIds, fieldsFor, TURN_PRESETS, loadTurnPreset, TURN_PRESET_DEFAULT } = client.__internals

const plain = JSON.parse(readFileSync(join(here, 'fixtures', 'real-plain.json'), 'utf8')).messages
const advanced = JSON.parse(readFileSync(join(here, 'fixtures', 'real-advanced.json'), 'utf8')).messages

test('the real session groups into turns instead of vanishing', () => {
  // The regression: `turn: null` on the rows before the first human turn, and a
  // guard that treated a non-number as 0 and then skipped 0. Every row went, so
  // the turn view came up blank with a green test suite.
  const turns = groupTurns(plain)
  const expected = new Set(plain.map((row) => row.turn).filter((turn) => Number.isInteger(turn) && turn >= 1))
  assert.equal(turns.length, expected.size, 'the turn count must match the turns in the log')
  assert.ok(turns.length > 0, 'an empty turn list is the bug this test exists for')
  const grouped = turns.reduce((sum, turn) => sum + turn.rows.length, 0)
  const belonging = plain.filter((row) => Number.isInteger(row.turn) && row.turn >= 1).length
  assert.equal(grouped, belonging, 'every row that belongs to a turn must land in one')
  for (const turn of turns) {
    assert.ok(turn.rows.length > 0, 'a turn with no rows cannot be picked apart')
    assert.equal(typeof turn.turn, 'number')
    assert.ok(turn.turn >= 1)
  }
})

test('rows before the first human turn are not a turn, but do not drop the rest', () => {
  // `turn: null` is what the host sends for a row logged before the first human
  // turn. `typeof null === 'object'`, so a guard written as
  // `const n = typeof turn === 'number' ? turn : 0; if (n === 0) continue`
  // happens to skip only that row — but the same guard written as
  // `if (!Number.isInteger(n) || n < 1) continue` skips it too, and the two
  // differ the moment a row carries 0 rather than null. What must hold either
  // way is that the *following* turns survive.
  const withPreamble = [
    { id: 'a', seq: 1, turn: null, kind: 'assistant', role: 'assistant', text: '开场白' },
    { id: 'b', seq: 2, turn: 1, kind: 'user', role: 'user', text: '问题' },
    { id: 'c', seq: 3, turn: 1, kind: 'assistant', role: 'assistant', text: '回答' },
    { id: 'd', seq: 4, turn: 2, kind: 'user', role: 'user', text: '第二个问题' },
  ]
  const turns = groupTurns(withPreamble)
  assert.equal(turns.length, 2, 'a null turn must not swallow the turns that follow it')
  assert.equal(turns[0].rows.length, 2)
  assert.equal(turns[0].title, '问题')
  assert.equal(turns[0].final.id, 'c')
  assert.equal(turns[1].title, '第二个问题')
  // The preamble is not in any turn, and no turn claims it.
  assert.equal(turns.some((turn) => turn.rows.some((row) => row.id === 'a')), false)
})

test('every real turn resolves input, final and process to rows', () => {
  for (const turn of groupTurns(plain)) {
    assert.ok(fieldIds(turn, 'input').length > 0, `turn ${turn.turn} has no input`)
    assert.equal(fieldIds(turn, 'final').length, 1, `turn ${turn.turn} has no single final output`)
    assert.ok(fieldIds(turn, 'process').length > 0, `turn ${turn.turn} has no working dialogue`)
  }
})

test('the advanced row set gives every real turn detail to offer', () => {
  // 详细内容 is the kind that is empty in the plain set and populated in the
  // advanced one, which is what makes it both worth having and easy to break.
  const turns = groupTurns(advanced)
  assert.ok(turns.length >= 3)
  for (const turn of turns) {
    assert.ok(fieldIds(turn, 'detail').length > 0, `turn ${turn.turn} has no detail rows even in the advanced set`)
  }
})

test('a whole-turn tick covers every row, fields or no fields', () => {
  // The two controls are independent: the four field boxes narrow the choice,
  // and the turn-level tick takes all of it. If the turn tick were built from
  // the field sets it would change meaning whenever a kind was turned off.
  for (const source of [plain, advanced]) {
    for (const turn of groupTurns(source)) {
      const ids = turnIds(turn)
      assert.deepEqual(ids, turn.rows.map((row) => row.id))
      assert.equal(new Set(ids).size, ids.length, 'a duplicated id would tick a row twice')
      // The union of the four kinds is exactly the whole turn.
      const union = TURN_PRESETS.full.flatMap((field) => fieldIds(turn, field))
      assert.equal(new Set(union).size, ids.length, `turn ${turn.turn}: the field kinds do not cover every row`)
    }
  }
})

test('the default choice is a real field set out of the box', () => {
  // The regression behind the checkbox mess: an empty default meant every box
  // rendered off, and nothing could be turned on. `loadTurnPreset` resolves a
  // named preset through the table, so a default that is not in the table, or a
  // table lookup that misses, shows up here rather than as a blank view.
  const choice = loadTurnPreset()
  assert.equal(choice.preset, TURN_PRESET_DEFAULT)
  assert.deepEqual(choice.fields, TURN_PRESETS.standard)
  assert.ok(choice.fields.length > 0, 'an empty default choice disables the whole view')
  assert.ok(choice.fields.includes('input'))
  assert.ok(choice.fields.includes('final'))
  assert.ok(choice.fields.includes('process'))
  assert.equal(choice.fields.includes('detail'), false, 'detail is the expensive kind; it is not on by default')
})

test('the default names a preset that exists', () => {
  // A typo in either the default's name or the table's keys silently produces an
  // empty field array, because `TURN_PRESETS[name]` is `undefined` and every
  // `.includes` on it is false. That is the shape of the bug this guards.
  assert.ok(TURN_PRESET_DEFAULT in TURN_PRESETS, `"${TURN_PRESET_DEFAULT}" is not a preset`)
  for (const fields of Object.values(TURN_PRESETS)) {
    assert.ok(Array.isArray(fields) && fields.length > 0)
  }
})

test('a turn can ask for detail before any detail row has been fetched', () => {
  // The deadlock: 详细内容 was disabled while the turn had no detail rows, and
  // the rows only arrived if it was ticked. The choice must therefore resolve to
  // a usable field set on its own, with no reference to the rows in hand — which
  // is exactly what `fieldsFor` does, and what the checkbox state now reads.
  const turnId = 'turn-1'
  const plainTurn = groupTurns(plain)[0]
  assert.equal(fieldIds(plainTurn, 'detail').length, 0, 'the plain set has no detail rows to show')

  const defaults = TURN_PRESETS.standard
  const untouched = fieldsFor(defaults, new Map(), turnId)
  assert.equal(untouched.includes('detail'), false)

  // Ticking the box writes an override; that is what has to survive with zero
  // detail rows present.
  const withDetail = TURN_PRESETS.full.filter((field) => field === 'detail' || defaults.includes(field))
  const overrides = new Map([[turnId, withDetail]])
  assert.equal(fieldsFor(defaults, overrides, turnId).includes('detail'), true)
})