/**
 * The panel must get a definite height, and the list must scroll inside it.
 *
 * Three attempts at this by CSS alone were shipped and none of them worked in
 * the real shell. The cause is in the shell's own stylesheet, not here:
 *
 *   _tabHost      — stretched by dockkit, definite height
 *     _tabHostBody — `position: relative; min-width: 0` — NO height, not flex
 *       .tabBody   — `height: 100%`  →  100% of auto = auto
 *
 * So a percentage height below that point has nothing to resolve against and
 * every `flex: 1 1 auto; min-height: 0` resolves to "as tall as the content",
 * which makes the panel grow past the bottom edge and the pane clip the
 * composer away. The fix measures one number — the distance from the panel's
 * top down to the nearest ancestor that clips it — and writes it on the root;
 * everything inside is then ordinary flex.
 *
 * These tests pin that behaviour down in a DOM: the root carries a bounded
 * inline height, the boxes below it are flex, and loading more rows changes the
 * content without changing any box.
 *
 * Skipped when React/jsdom are not installed, like the other DOM tests;
 * `npm run check:render` puts them in place.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const TOOLS = join(root, '.tools', 'node_modules')

const missing = ['react', 'react-dom', 'jsdom'].filter((name) => !existsSync(join(TOOLS, name)))
const skip = missing.length === 0
  ? false
  : `${missing.join(', ')} not installed locally; run \`npm run check:render\``

/**
 * Boot jsdom inside a shell-like wrapper and render the panel.
 *
 * The wrapper reproduces the shell's shape on purpose: a clipping box with a
 * definite height, a `position:relative` box with NO height inside it (this is
 * `_tabHostBody`), and the panel below that. Getting this wrong is what made a
 * pure-CSS fix look correct in a test and fail in the app.
 *
 * @returns `{ document, window, act, click, openPicker, root, unmount }`.
 */
async function harness() {
  const { JSDOM } = await import('file://' + join(TOOLS, 'jsdom', 'lib', 'api.js').replaceAll('\\', '/'))
  const React = (await import('file://' + join(TOOLS, 'react', 'index.js').replaceAll('\\', '/'))).default
  const { createRoot } = await import('file://' + join(TOOLS, 'react-dom', 'client.js').replaceAll('\\', '/'))
  const { act } = React

  const dom = new JSDOM(
    '<!doctype html><html><body><div id="shell"><div id="body"><div id="root"></div></div></div></body></html>',
    { url: 'http://127.0.0.1/', pretendToBeVisual: true },
  )
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

  window.innerHeight = 800
  Object.defineProperty(window.document.documentElement, 'clientHeight', {
    value: 800, configurable: true,
  })

  // The shell geometry: the clipping box ends at y=800, the tab body box begins
  // at y=40 and — like `_tabHostBody` — has no height of its own, so the panel
  // starts at 40 and must be told it has 760px.
  const shell = window.document.getElementById('shell')
  const bodyBox = window.document.getElementById('body')
  const realRect = window.Element.prototype.getBoundingClientRect
  window.Element.prototype.getBoundingClientRect = function patched() {
    if (this === shell) {
      return { top: 0, left: 0, width: 320, height: 800, right: 320, bottom: 800, x: 0, y: 0 }
    }
    if (this === bodyBox) {
      // No height: exactly the shell's `_tabHostBody`.
      return { top: 40, left: 0, width: 320, height: 0, right: 320, bottom: 40, x: 0, y: 40 }
    }
    if (this.classList?.contains('dswc-root')) {
      const height = Number.parseInt(this.style.height, 10)
      const measured = Number.isFinite(height) ? height : 0
      return {
        top: 40, left: 0, width: 320, height: measured,
        right: 320, bottom: 40 + measured, x: 0, y: 40,
      }
    }
    return realRect.call(this)
  }

  // The vertical clip is what the measurement walks up to find. jsdom's
  // getComputedStyle returns '' for `overflow-y` by default, so state it.
  const realComputed = window.getComputedStyle.bind(window)
  window.getComputedStyle = (element, pseudo) => {
    const style = realComputed(element, pseudo)
    if (element === shell) {
      return Object.assign(Object.create(style), style, { overflowY: 'hidden', getPropertyValue: (name) => (name === 'overflow-y' ? 'hidden' : style.getPropertyValue(name)) })
    }
    return style
  }
  globalThis.getComputedStyle = window.getComputedStyle

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
    addEventListener: () => {}, removeEventListener: () => {},
    setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window),
    setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
    matchMedia: mm,
  }
  const require = (name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  }
  // The host answers with a long session, so the list has far more content than
  // room: that is the only way "it scrolls" is a meaningful assertion.
  const longSession = {
    messages: Array.from({ length: 200 }, (_, index) => ({
      seq: index + 1,
      id: `${index + 1}:0`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      kind: index % 2 === 0 ? 'user' : 'assistant',
      text: `row ${index + 1} — ${'x'.repeat(80)}`,
      turn: Math.floor(index / 2) + 1,
    })),
    dropped: 0,
    ok: true,
  }
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
    mm, async () => ({ json: async () => longSession }), storage,
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

  const reactRoot = createRoot(document.getElementById('root'))
  const templates = { 'picker.selected': '{count} selected' }
  const translate = (key, values) => {
    const template = templates[key] ?? String(key)
    return values === undefined
      ? template
      : template.replace(/\{(\w+)\}/g, (whole, name) => (values[name] === undefined ? whole : String(values[name])))
  }

  const click = async (node) => {
    await act(async () => { node.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)) })
  }

  await act(async () => {
    reactRoot.render(React.createElement(body, {
      sessionId: 's1',
      t: translate,
      useTabInfo: () => ({ tab: { sessionId: 's1', visible: false } }),
    }))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)) })

  const openPicker = async () => {
    const button = [...document.querySelectorAll('button')].find((node) => node.textContent.includes('action.send'))
    assert.ok(button !== undefined, 'no 「引用上下文」 button')
    await click(button)
  }

  return {
    window, document, act, click, openPicker,
    root: reactRoot,
    unmount: async () => { await act(async () => { reactRoot.unmount() }) },
  }
}

const heightOfPanel = (document) =>
  Number.parseInt(document.querySelector('.dswc-root').style.height, 10)

test('the panel is told the height the shell left it, not the height its content wants', { skip }, async () => {
  const { document, openPicker, unmount } = await harness()
  try {
    await openPicker()
    const inline = document.querySelector('.dswc-root').style.height
    assert.match(inline, /^\d+px$/, `the panel has no measured height (style.height = "${inline}")`)
    const height = Number.parseInt(inline, 10)

    // 800px clip bottom − 40px panel top = 760. The exact number is not the
    // point; that it comes from the clip edge rather than from the content is.
    assert.equal(height, 760, `the panel measured ${height}px, not the 760px the shell offers`)

    // And it is fixed-size, not content-sized.
    assert.match(document.querySelector('.dswc-root').style.flex, /^0 0 auto$/,
      'the panel still grows with its content')
  } finally {
    await unmount()
  }
})

test('loading more rows grows the content but not the panel', { skip }, async () => {
  // The property that matters: the panel's box is fixed and the rows pile up
  // inside the list. Paging is how "content taller than the box" is reached.
  const { document, click, openPicker, unmount } = await harness()
  try {
    await openPicker()
    const rowsOf = () => document.querySelectorAll('.dswc-list .dswc-row').length

    const startHeight = heightOfPanel(document)
    const startRows = rowsOf()
    assert.ok(startRows > 0, 'the long session drew no rows')

    for (let page = 0; page < 3; page += 1) {
      const more = [...document.querySelectorAll('.dswc-list button')]
        .find((node) => node.textContent.includes('action.loadEarlier'))
      if (more === undefined) break
      await click(more)
    }

    const endRows = rowsOf()
    const endHeight = heightOfPanel(document)
    assert.ok(endRows > startRows, `loading earlier did not add rows (${startRows} → ${endRows})`)
    assert.equal(endHeight, startHeight, `the panel grew with its content (${startHeight} → ${endHeight})`)
  } finally {
    await unmount()
  }
})

test('the measured height follows the clip box when it changes', { skip }, async () => {
  // A resized window moves the clip bottom; the panel has to re-measure rather
  // than keep the height from its first render. The poll is the backstop for
  // hosts that re-lay out without a window resize, so waiting on it is enough.
  const { window, document, openPicker, unmount } = await harness()
  try {
    await openPicker()
    assert.equal(heightOfPanel(document), 760)

    // Shorten the clipping box by 200px, then let the backstop notice.
    const shell = window.document.getElementById('shell')
    const realComputed = window.getComputedStyle
    window.Element.prototype.getBoundingClientRect = (function (previous) {
      return function patched() {
        if (this === shell) {
          return { top: 0, left: 0, width: 320, height: 600, right: 320, bottom: 600, x: 0, y: 0 }
        }
        return previous.call(this)
      }
    })(window.Element.prototype.getBoundingClientRect)
    void realComputed

    await new Promise((resolve) => setTimeout(resolve, 2400))

    assert.equal(heightOfPanel(document), 560, 'the panel did not re-measure after the clip box moved')
  } finally {
    await unmount()
  }
})
