/**
 * Render the whole tab body with real React.
 *
 * The unit tests cover the pure helpers. This covers what they cannot: that
 * `apply()` still registers everything with a real context, and that the body
 * component actually *executes* — no helper used before it is defined, no
 * `ReferenceError` hiding behind a condition that a thumbnail review would miss.
 *
 * The component is reached the way the shell reaches it: `apply(ctx)` registers
 * it against `sidebar.right.pane.tab`, so the fake context records what was
 * registered and the test renders that.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)

// React is not a dependency of this package: the shell supplies it at runtime
// and CI publishes without installing anything. The render checks are therefore
// dependent on a local React being present, and skip rather than fail where it
// is not — `scripts/render-check.mjs` sets one up on demand for anyone who wants
// them to run, and `npm run check:render` is the documented way in.
const REACT_DIRS = [
  join(root, '.tools', 'node_modules'),   // the scratch install used by check:render
  join(root, 'node_modules'),             // a developer who installed react here
]
const reactDir = REACT_DIRS.find((dir) => existsSync(join(dir, 'react', 'index.js')))
const skip = reactDir === undefined
  ? 'react is not installed locally; run `npm run check:render`'
  : false

/** Imported lazily so a missing React cannot fail the file at load time. */
const React = skip === false ? (await import('file://' + join(reactDir, 'react', 'index.js').replaceAll('\\', '/'))).default : null
const renderToStaticMarkup = skip === false
  ? (await import('file://' + join(reactDir, 'react-dom', 'server.browser.js').replaceAll('\\', '/'))).renderToStaticMarkup
  : null

/** Load `lib/client.js` the way the shell does, with React behind `require`. */
function loadClient() {
  const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  let registered
  const store = new Map()
  const window = {
    __ModuleLoader__: { load: (entry) => { registered = entry } },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
    },
    // No `dshDesktop`: this harness is the "plain web profile" case, which has
    // no browser channel. The body has to say so rather than throw.
  }
  const require = (name) => {
    if (name === 'react') return React
    throw new Error('unexpected require: ' + name)
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'navigator', 'document', 'matchMedia', source)
  run(
    window,
    { language: 'zh-CN', userAgent: 'node' },
    {
      querySelector: () => null,
      createElement: () => ({ style: {}, setAttribute: () => {} }),
      head: { appendChild: () => {} },
    },
    () => ({ matches: false }),
  )
  return registered.factory(require)
}

/**
 * Run `apply()` against a context that records registrations, which is how the
 * body component is obtained without a shell.
 * @returns `{ body, tab, header }` — the registered components.
 */
function install(plugin) {
  const registered = {}
  const ctx = {
    effect: (fn) => { const dispose = fn(); return dispose },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    slots: {
      inject: (name, fn) => {
        const value = fn()
        registered[name] = value
        return value
      },
      register: (options, component) => {
        registered.components = registered.components ?? {}
        registered.components[options.key ?? options.id] = component
        return () => {}
      },
    },
    sidebarRightTabs: { register: (options) => { registered.tab = options; return () => {} } },
    sidebarRight: { openTabIn: () => {} },
  }
  plugin.apply(ctx)
  return { registered, body: registered.components['dsh-deepseek-webchat'] }
}

// Loading the bundle is itself a React operation — its registration path calls
// `createElement` — so it has to be part of what the skip guards, not just the
// test bodies. Both are therefore built only when React was found.
const loaded = skip === false
  ? (() => {
    const plugin = loadClient()
    return { plugin, ...install(plugin) }
  })()
  : { plugin: null, registered: null, body: null }

const { registered, body } = loaded

test('apply registers the tab, the body and the header door', { skip }, () => {
  assert.equal(typeof body, 'function')
  assert.equal(registered.tab.kind, 'deepseek-webchat')
  assert.equal(registered.tab.keepMounted, true)
  assert.equal(typeof registered.components['deepseek-webchat'], 'function')
})

test('the body renders the "no browser channel" notice rather than throwing', { skip }, () => {
  const element = React.createElement(body, {
    sessionId: 's1',
    t: (key) => key,
    useTabInfo: () => ({ tab: { sessionId: 's1', visible: true } }),
  })
  const html = renderToStaticMarkup(element)
  assert.match(html, /dswc-root/)
  assert.match(html, /dswc-toolbar/)
  assert.match(html, /status\.nobridge/)
})

test('with the picker closed the body is the page, not the picker', { skip }, () => {
  // The regression 0.6.0 shipped: the `!pickerOpen` branch — and with it the
  // `.dswc-host` rectangle the guest is parked on — was dropped from the render,
  // so the panel showed the quote picker's empty shell in the page view and the
  // DeepSeek page was never placed. The host element must be there, and the
  // picker must not.
  const previous = globalThis.dshDesktop
  globalThis.dshDesktop = { protocolVersion: 1, browser: { acquire: () => ({}) } }
  try {
    const html = renderToStaticMarkup(React.createElement(body, {
      sessionId: 's1',
      t: (key) => key,
      useTabInfo: () => ({ tab: { sessionId: 's1', visible: true } }),
    }))
    assert.match(html, /dswc-host/, 'the page view has no rectangle to park the guest on')
    assert.match(html, /dswc-toolbar/)
    assert.equal(/dswc-picker/.test(html), false, 'the picker is rendering in the page view')
  } finally {
    globalThis.dshDesktop = previous
  }
})

test('the header door renders', { skip }, () => {
  const html = renderToStaticMarkup(React.createElement(registered.components['deepseek-webchat'], {
    t: (key) => key,
    open: () => {},
  }))
  assert.match(html, /dswc-headerButton/)
})
