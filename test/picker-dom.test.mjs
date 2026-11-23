/**
 * Render the picker with jsdom and read what it actually drew.
 *
 * The other tests are unit tests over the turn model, and they were green while
 * three bugs shipped — because none of them rendered anything. This one drives
 * the real component: open the picker, switch to the turn view, tick a box, and
 * assert on the DOM afterwards. It is the only check that would have caught
 *
 *   - every turn checkbox rendering `off` while the default said on (the choice
 *     was read from the selection instead of from the turn's fields),
 *   - 详细内容 being permanently disabled (its rows only exist after the fetch
 *     that ticking it triggers),
 *   - the turn list coming up empty.
 *
 * Skipped when React is not installed, like `test/render.test.mjs`; `npm run
 * check:render` puts it in place.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const TOOLS = join(root, '.tools', 'node_modules')

// All three are needed, not just React: the whole point of this file is a real
// DOM, and jsdom is as optional here as React is.
const missing = ['react', 'react-dom', 'jsdom'].filter((name) => !existsSync(join(TOOLS, name)))
const skip = missing.length === 0
  ? false
  : `${missing.join(', ')} not installed locally; run \`npm run check:render\``

const plain = JSON.parse(readFileSync(join(here, 'fixtures', 'real-plain.json'), 'utf8'))
const advanced = JSON.parse(readFileSync(join(here, 'fixtures', 'real-advanced.json'), 'utf8'))

/**
 * Boot jsdom, the bundle and a fake host, then hand back the tools to drive it.
 * @returns `{ document, window, React, act, click, open }`.
 */
async function harness() {
  const { JSDOM } = await import('file://' + join(TOOLS, 'jsdom', 'lib', 'api.js').replaceAll('\\', '/'))
  const React = (await import('file://' + join(TOOLS, 'react', 'index.js').replaceAll('\\', '/'))).default
  const { createRoot } = await import('file://' + join(TOOLS, 'react-dom', 'client.js').replaceAll('\\', '/'))
  const { act } = React

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1/',
    pretendToBeVisual: true,
  })
  const { window } = dom
  globalThis.window = window
  globalThis.document = window.document
  Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
  globalThis.HTMLElement = window.HTMLElement
  globalThis.Element = window.Element
  globalThis.getComputedStyle = window.getComputedStyle.bind(window)
  const mm = () => ({ matches: false, addListener: () => {}, removeListener: () => {} })
  globalThis.matchMedia = mm
  window.matchMedia = mm
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  // The bridge, on the real global: `bridge()` reads `globalThis.dshDesktop`.
  globalThis.dshDesktop = {
    protocolVersion: 1,
    browser: { acquire: async () => ({ partition: 'p', lease: 'l' }), release: () => {} },
  }

  const element = {
    style: {}, setAttribute: () => {}, getAttribute: () => null,
    addEventListener: () => {}, removeEventListener: () => {},
    loadURL: () => Promise.resolve(), reload: () => {},
    getURL: () => 'https://chat.deepseek.com/a/chat/s/abc',
    insertText: () => {}, sendInputEvent: () => {},
    executeJavaScript: () => Promise.resolve(''), focus: () => {},
  }
  const storage = window.localStorage
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  let registered
  const fakeWindow = {
    __ModuleLoader__: { load: (entry) => { registered = entry } },
    localStorage: storage,
    // The batch listens for Shift's release on this window, so it has to be a
    // real event target rather than a no-op — otherwise every test here would
    // silently run inside one never-ending batch.
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window),
    setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
    matchMedia: mm,
  }
  const require = (name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  }
  // The host answers the advanced request with the advanced set: serving one
  // fixed payload regardless of the query hides every re-fetch bug.
  const fetchStub = async (url) => ({
    json: async () => (String(url).includes('advanced=1') ? advanced : plain),
  })
  const run = new Function('window', 'navigator', 'document', 'matchMedia', 'fetch', 'localStorage', source)
  run(
    fakeWindow, window.navigator,
    {
      querySelector: () => null,
      createElement: () => element,
      head: { appendChild: () => {} },
      body: { appendChild: () => {}, removeChild: () => {} },
      documentElement: { appendChild: () => {}, removeChild: () => {} },
      addEventListener: () => {}, removeEventListener: () => {},
    },
    mm, fetchStub, storage,
  )

  const plugin = registered.factory(require)
  let body
  plugin.apply({
    effect: (fn) => fn(),
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: {
      inject: (name, fn) => fn(),
      register: (options, component) => {
        if (options.key === 'dsh-deepseek-webchat') body = component
        return () => {}
      },
    },
    sidebarRightTabs: { register: () => () => {} },
    sidebarRight: { openTabIn: () => {} },
  })

  const rootNode = document.getElementById('root')
  const reactRoot = createRoot(rootNode)

  const click = async (node, init = {}) => {
    await act(async () => { node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, ...init })) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)) })
  }

  /** Release Shift, which is what closes a batch. */
  const releaseShift = async () => {
    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Shift' }))
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
  }

  /** Press Shift, which also closes one — see the recovery path in the body. */
  const pressShift = async () => {
    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Shift' }))
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
  }

  await act(async () => {
    reactRoot.render(React.createElement(body, {
      sessionId: 's1',
      t: (key, values) => (values === undefined
        ? String(key)
        : String(key).replace(/\{(\w+)\}/g, (whole, name) => (values[name] === undefined ? whole : String(values[name])))),
      useTabInfo: () => ({ tab: { sessionId: 's1', visible: false } }),
    }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)) })

  /** Open the picker from the toolbar. */
  const openPicker = async () => {
    const button = [...document.querySelectorAll('button')].find((node) => node.textContent.includes('action.send'))
    assert.ok(button !== undefined, 'no 「引用上下文」 button')
    await click(button)
  }

  /** Switch to the turn view. */
  const openTurns = async () => {
    const tab = [...document.querySelectorAll('.dswc-segment')].find((node) => node.textContent.includes('view.turns'))
    assert.ok(tab !== undefined, 'no turn view tab')
    await click(tab)
  }

  return { window, document, React, act, click, pressShift, releaseShift, root: reactRoot, openPicker, openTurns }
}

test('the picker draws rows and a view strip', { skip }, async () => {
  const { document, act, root, openPicker } = await harness()
  try {
    await openPicker()
    assert.ok(document.querySelectorAll('.dswc-row').length > 0, 'no rows were drawn')
    assert.ok(document.querySelector('.dswc-viewBar') !== null, 'no view strip')
  } finally {
    await act(async () => { root.unmount() })
  }
})

test('the turn view draws turns, and their boxes read the turn default', { skip }, async () => {
  const { document, act, root, openPicker, openTurns } = await harness()
  try {
    await openPicker()
    await openTurns()
    const turns = [...document.querySelectorAll('.dswc-turn')]
    assert.ok(turns.length > 0, 'the turn view drew no turns')

    // The default is 标准: input, final and process on, detail off. A box that
    // reads the *selection* instead draws every one of them off, because nothing
    // is selected until the reader picks something.
    for (const turn of turns) {
      const fields = Object.fromEntries([...turn.querySelectorAll('.dswc-field')].map((node) => [
        node.getAttribute('data-field'),
        node.querySelector('input[type="checkbox"]').checked,
      ]))
      assert.equal(fields.input, true, '「用户输入」 is not ticked on a fresh turn view')
      assert.equal(fields.final, turn.querySelector('.dswc-turnFields') !== null)
      assert.equal(fields.process, true, '「过程对话」 is not ticked on a fresh turn view')
      assert.equal(fields.detail, false, '「详细内容」 is on by default')
    }
  } finally {
    await act(async () => { root.unmount() })
  }
})

test('a turn has a whole-turn tick beside its four kind boxes', { skip }, async () => {
  // The two controls coexist on purpose and answer different questions: the
  // turn tick says "all of this turn", the four boxes say which kinds. Folding
  // a turn must never tick it, and ticking it must not remove the boxes.
  const { document, act, click, root, openPicker, openTurns } = await harness()
  try {
    await openPicker()
    await openTurns()
    const turn = [...document.querySelectorAll('.dswc-turn')].at(-1)
    const pick = turn.querySelector('.dswc-turnPick')
    const caret = turn.querySelector('.dswc-caret')
    assert.ok(pick !== null, 'no whole-turn tick')
    assert.ok(caret !== null, 'no fold control')
    assert.equal(pick.getAttribute('role'), 'checkbox')
    // Untouched: the fields say 标准, but the selection is empty, so the turn
    // tick is not on yet.
    assert.equal(pick.getAttribute('aria-checked'), 'false')
    assert.equal(turn.querySelectorAll('.dswc-field').length, 4, 'the four kind boxes are gone')

    // The fold is a separate button and does not tick anything.
    await click(caret)
    const folded = [...document.querySelectorAll('.dswc-turn')].at(-1)
    assert.equal(folded.querySelector('.dswc-turnPick').getAttribute('aria-checked'), 'false',
      'folding a turn ticked it')
    assert.equal(folded.querySelector('.dswc-turnRows') !== null, true, 'the fold did not open the rows')

    // Ticking the turn covers all of its rows, and the kind boxes then read as
    // fully ticked for every kind the fetched set actually carries. 详细内容 stays
    // off here because 「高级」 is off: there are no detail rows to cover, and
    // marking it would ask for the expensive row set as a side effect of a click.
    const target = [...document.querySelectorAll('.dswc-turn')].at(-1)
    await click(target.querySelector('.dswc-turnPick'))
    const ticked = [...document.querySelectorAll('.dswc-turn')].at(-1)
    assert.equal(ticked.querySelector('.dswc-turnPick').getAttribute('aria-checked'), 'true')
    const states = Object.fromEntries([...ticked.querySelectorAll('.dswc-field')].map((node) => [
      node.getAttribute('data-field'), node.getAttribute('data-state'),
    ]))
    assert.equal(states.input, 'on', `the whole-turn tick left 用户输入 ${states.input}`)
    assert.equal(states.final, 'on', `the whole-turn tick left 最终输出 ${states.final}`)
    assert.equal(states.process, 'on', `the whole-turn tick left 过程对话 ${states.process}`)
    assert.equal(states.detail, 'off', '高级 is off, so there are no detail rows to cover')

    // And unticking it clears them again.
    await click(ticked.querySelector('.dswc-turnPick'))
    const cleared = [...document.querySelectorAll('.dswc-turn')].at(-1)
    assert.equal(cleared.querySelector('.dswc-turnPick').getAttribute('aria-checked'), 'false')
    const after = Object.fromEntries([...cleared.querySelectorAll('.dswc-field')].map((node) => [
      node.getAttribute('data-field'), node.getAttribute('data-state'),
    ]))
    assert.equal(Object.values(after).every((state) => state === 'off'), true,
      `untick left ${JSON.stringify(after)}`)
  } finally {
    await act(async () => { root.unmount() })
  }
})

test('详细内容 can be ticked while the turn has no detail rows yet', { skip }, async () => {
  const { document, act, root, openPicker, openTurns } = await harness()
  try {
    await openPicker()
    await openTurns()
    const turn = [...document.querySelectorAll('.dswc-turn')].at(-1)
    const box = [...turn.querySelectorAll('.dswc-field')].find((node) => node.getAttribute('data-field') === 'detail')
    assert.ok(box !== undefined, 'no 详细内容 box')
    const input = box.querySelector('input[type="checkbox"]')
    assert.equal(input.disabled, false, '详细内容 is disabled, so it can never be asked for')
    assert.equal(input.checked, false)

    await act(async () => { input.click() })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)) })

    const after = [...document.querySelectorAll('.dswc-turn')].at(-1)
    const afterBox = [...after.querySelectorAll('.dswc-field')].find((node) => node.getAttribute('data-field') === 'detail')
    assert.equal(afterBox.querySelector('input[type="checkbox"]').checked, true, 'the tick did not survive a render')
    assert.equal(afterBox.getAttribute('data-state'), 'on', 'the drawn box disagrees with the control')
  } finally {
    await act(async () => { root.unmount() })
  }
})

/**
 * The ticked rows, by position in the whole list.
 *
 * Read from `aria-checked` rather than from any internal state: the model under
 * test is what the reader sees, and the whole class of bug this file exists for
 * was a state that was right while the drawn box was wrong.
 * @param document - the harness document.
 * @returns sorted row indices that are ticked.
 */
function ticked(document) {
  return [...document.querySelectorAll('.dswc-row')]
    .filter((node) => node.getAttribute('aria-checked') === 'true')
    .map((node) => Number(node.getAttribute('data-index')))
    .sort((a, b) => a - b)
}

/**
 * The row at `index` in the whole list, whether or not it is mounted.
 * @param document - the harness document.
 * @param index - the row's position.
 * @returns the row element.
 */
function rowAt(document, index) {
  const node = [...document.querySelectorAll('.dswc-row')]
    .find((candidate) => candidate.getAttribute('data-index') === String(index))
  assert.ok(node !== undefined, `row ${index} is not mounted`)
  return node
}

test('a shift batch flips every row between its anchor and the far end, both included', { skip }, async () => {
  const { document, act, click, pressShift, releaseShift, root, openPicker } = await harness()
  try {
    await openPicker()
    const indices = [...document.querySelectorAll('.dswc-row')].map((node) => Number(node.getAttribute('data-index')))
    assert.ok(indices.length >= 4, 'the fixture is too short for a block')
    const [a, b, c, d] = indices.slice(-4)

    // Open a batch on the first of the four and take it to the third: the two
    // ends are flipped too, which is what "含两端" means.
    await pressShift()
    await click(rowAt(document, b), { shiftKey: true })
    await click(rowAt(document, d), { shiftKey: true })
    assert.deepEqual(ticked(document), [b, c, d], 'the block skipped one of its ends')

    // Still holding Shift, click nearer the anchor: the far end moves back and
    // the block shrinks. It must not accumulate.
    await click(rowAt(document, c), { shiftKey: true })
    assert.deepEqual(ticked(document), [b, c], 'a second shift-click accumulated instead of redrawing')

    // Letting go of Shift is what starts a new batch; the next Shift-click's
    // anchor is where it lands, not the old one.
    await releaseShift()
    await pressShift()
    await click(rowAt(document, a), { shiftKey: true })
    await releaseShift()
    assert.deepEqual(ticked(document), [a, b, c], 'the old anchor outlived the batch')
  } finally {
    await act(async () => { root.unmount() })
  }
})

test('a shift batch inverts rows that were already ticked', { skip }, async () => {
  const { document, act, click, pressShift, releaseShift, root, openPicker } = await harness()
  try {
    await openPicker()
    const indices = [...document.querySelectorAll('.dswc-row')].map((node) => Number(node.getAttribute('data-index')))
    const [a, b, c, d] = indices.slice(-4)

    // Tick one row inside the block the ordinary way, then run a batch over it.
    await click(rowAt(document, c))
    assert.deepEqual(ticked(document), [c])

    await pressShift()
    await click(rowAt(document, b), { shiftKey: true })
    await click(rowAt(document, d), { shiftKey: true })
    // c was ticked, so the block took it off; b and d were not, so it put them on.
    assert.deepEqual(ticked(document), [b, d], 'the batch added the span instead of inverting it')

    // A batch over a block that was ticked by hand clears what it covers and
    // leaves rows outside it alone.
    await releaseShift()
    await click(rowAt(document, a))
    assert.deepEqual(ticked(document), [a, b, d])
    await pressShift()
    await click(rowAt(document, a), { shiftKey: true })
    await click(rowAt(document, b), { shiftKey: true })
    await releaseShift()
    assert.deepEqual(ticked(document), [d], 'a batch over a block ticked by hand left rows behind')
  } finally {
    await act(async () => { root.unmount() })
  }
})
