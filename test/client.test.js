/**
 * Browser-half tests: load the published bundle the way the Web GUI does, with
 * a stub module table and a stub cordis context, then assert the registrations
 * match the slots the shell actually owns.
 *
 * This is the half that cannot be exercised by the host tests, and it is the
 * half whose failure mode is worst — a bundle that loads without registering its
 * id fails the whole Web boot — so it is checked here.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
// Read the bundle at the exact path the manifest exports, so this test would
// also fail if the published layout ever drifted from the manifest again.
const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/**
 * A React stub: enough to run `createElement` and the module body, which never
 * renders during registration.
 */
const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useRef: (value) => ({ current: value }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}

/**
 * Load the bundle into a stub environment.
 * @param overrides - `document`/`window` members to add.
 * @returns `{ loaded, registrations, ctx, exports }`.
 */
function loadBundle(overrides = {}) {
  const registrations = []
  let loaded = null
  const head = { appendChild: () => {} }
  const document = {
    querySelector: () => null,
    createElement: () => ({ setAttribute: () => {}, textContent: '', style: {} }),
    head,
    body: { appendChild: () => {} },
    ...(overrides.document ?? {}),
  }
  const window = {
    __ModuleLoader__: {
      load: (entry) => {
        loaded = entry
      },
    },
    location: { origin: 'http://127.0.0.1:19387' },
    addEventListener: () => {},
    removeEventListener: () => {},
    ...(overrides.window ?? {}),
  }
  const require = (id) => {
    if (id === 'react') return ReactStub
    throw new Error(`unexpected module request: ${id}`)
  }
  // The bundle is an IIFE over globals, so run it with those globals in scope.
  // The loader provides `require` only: every bundle declares its own `module`
  // and `exports` inside the factory, so no shim is passed in here.
  const run = new Function('window', 'document', 'navigator', 'globalThis', bundle)
  run(
    window,
    document,
    { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' },
    window,
  )
  assert.notEqual(loaded, null, 'the bundle must call window.__ModuleLoader__.load')

  const moduleExports = loaded.factory(require)
  assert.equal(typeof moduleExports, 'object')
  const slots = {
    inject: (name, register) => {
      registrations.push({ kind: 'slots.inject', name, register })
    },
    register: (definition, component) => {
      registrations.push({ kind: 'slots.register', definition, component })
    },
  }
  const ctx = {
    slots,
    locale: {
      register: (ns, dictionaries) => {
        registrations.push({ kind: 'locale.register', ns, dictionaries })
      },
      bind: () => (key, values) => {
        const template = key
        if (values === undefined) return template
        return String(template).replace(/\{(\w+)\}/g, (whole, name) => (
          name in values ? String(values[name]) : whole
        ))
      },
    },
    sidebarRightTabs: {
      register: (definition) => {
        registrations.push({ kind: 'sidebarRightTabs.register', definition })
      },
    },
    sidebarRight: {
      openTabIn: (sessionId, kind, options) => {
        registrations.push({ kind: 'sidebarRight.openTabIn', sessionId, tabKind: kind, options })
      },
    },
    effect: (fn) => {
      registrations.push({ kind: 'effect' })
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
  }
  return { loaded, registrations, ctx, exports: moduleExports }
}

describe('browser bundle', () => {
  it('loads under the manifest name, which the shell keys on', () => {
    const { loaded } = loadBundle()
    assert.equal(loaded.id, manifest.name)
    assert.equal(typeof loaded.factory, 'function')
  })

  it('exports apply and inject, and returns its exports', () => {
    const { exports } = loadBundle()
    assert.equal(typeof exports.apply, 'function')
    assert.ok(Array.isArray(exports.inject))
    // A bundle that returns nothing fails the Web boot.
    assert.equal(typeof exports, 'object')
  })

  it('declares the client inject list the manifest promises', () => {
    const { exports } = loadBundle()
    assert.deepEqual(exports.inject, ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'])
    // The manifest's package-level inject list must name the packages that own
    // the surfaces this plugin registers into, or its slots arrive too early.
    assert.deepEqual(manifest.dsh.client.inject, [
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-sidebar-right',
    ])
  })
})

describe('registrations', () => {
  /** @returns the registrations after `apply`. */
  function applied() {
    const bundle = loadBundle()
    bundle.exports.apply(bundle.ctx)
    return bundle.registrations
  }

  it('registers the tab type with a kind, a title and a guide door', () => {
    const found = applied().find(
      (entry) => entry.kind === 'sidebarRightTabs.register',
    )
    assert.notEqual(found, undefined, 'the tab type must be registered')
    const definition = found.definition
    assert.equal(definition.id, manifest.name)
    assert.equal(typeof definition.kind, 'string')
    assert.ok(definition.kind.length > 0)
    assert.equal(typeof definition.title, 'function')
    // The webview must outlive a tab switch, or the page reloads every time.
    assert.equal(definition.keepMounted, true)
    assert.ok(Array.isArray(definition.guide))
    assert.ok(definition.guide.length > 0)
    assert.equal(typeof definition.guide[0].title, 'function')
  })

  it('registers a body for the session-scoped pane tab slot', () => {
    const names = applied()
      .filter((entry) => entry.kind === 'slots.inject')
      .map((entry) => entry.name)
    assert.ok(names.includes('sidebar.right.pane.tab'))
  })

  it('keys the body on the tab type id, so the shell dispatches to it', () => {
    const bundle = loadBundle()
    bundle.exports.apply(bundle.ctx)
    // `slots.inject` runs its factory lazily; call it to see the registration.
    let registered = null
    const injected = bundle.registrations.find(
      (entry) => entry.kind === 'slots.inject' && entry.name === 'sidebar.right.pane.tab',
    )
    injected.register()
    registered = bundle.registrations.filter((entry) => entry.kind === 'slots.register').at(-1)
    assert.equal(registered.definition.name, 'sidebar.right.pane.tab')
    assert.equal(registered.definition.key, manifest.name)
    assert.equal(typeof registered.component, 'function')
  })

  it('registers both dictionaries for its namespace', () => {
    const found = applied().find((entry) => entry.kind === 'locale.register')
    assert.notEqual(found, undefined)
    assert.equal(found.ns, manifest.name)
    assert.ok(found.dictionaries.zh['type.label'])
    assert.ok(found.dictionaries.en['type.label'])
  })

  it('offers a header door that opens this tab in the acting Session', () => {
    const bundle = loadBundle()
    bundle.exports.apply(bundle.ctx)
    const injected = bundle.registrations.find(
      (entry) => entry.kind === 'slots.inject'
        && entry.name === 'conversation.session.header.utilities',
    )
    assert.notEqual(injected, undefined, 'the header utility must be contributed')
    injected.register()
    const registered = bundle.registrations.filter((entry) => entry.kind === 'slots.register').at(-1)
    assert.equal(registered.definition.name, 'conversation.session.header.utilities')
    assert.equal(typeof registered.component, 'function')
    // The door must open this plugin's own kind, in the Session that clicked it.
    registered.definition.inject('session-7').open()
    const opened = bundle.registrations.find((entry) => entry.kind === 'sidebarRight.openTabIn')
    assert.equal(opened.sessionId, 'session-7')
    assert.equal(opened.tabKind, 'deepseek-webchat')
  })
})

describe('composer filling', () => {
  it('never submits: the fill script only sets the value and fires input', () => {
    // The script is built inline in the bundle; assert on its text so a future
    // edit cannot quietly add a click or a form submit.
    assert.ok(bundle.includes('dispatchEvent(new Event("input"'))
    assert.ok(bundle.includes('Object.getOwnPropertyDescriptor'))
    assert.equal(/\.submit\(\)|requestSubmit|dispatchEvent\(new KeyboardEvent/.test(bundle), false)
  })

  it('targets the class DeepSeek actually renders', () => {
    assert.ok(bundle.includes('textarea.ds-textarea__textarea'))
  })
})

describe('desktop guest channel', () => {
  it('goes through the shell bridge rather than an iframe', () => {
    assert.ok(bundle.includes('globalThis.dshDesktop'))
    assert.ok(bundle.includes('protocolVersion'))
    // The lease handshake: src carries the lease, partition must match it.
    assert.ok(bundle.includes("'about:blank#'"))
    assert.ok(bundle.includes("setAttribute('partition'"))
    assert.equal(/createElement\(['"]iframe['"]\)/.test(bundle), false)
  })

  it('hides the guest instead of unmounting it', () => {
    assert.ok(bundle.includes("style.display = 'none'"))
    assert.ok(bundle.includes("style.display = 'block'"))
  })

  it('does not rewrite an unchanged binding on every poll', () => {
    // The URL observer polls, so a binding write must be claimed once; without
    // the cache each poll re-POSTs and re-renders the panel forever.
    assert.ok(bundle.includes('boundPairs'))
    assert.ok(bundle.includes('if (boundPairs.has(pair)) return'))
  })

  it('clears that cache when a binding is forgotten', () => {
    assert.ok(bundle.includes('forgetBoundPairs'))
  })

  it('snapshots the guest login state to the host', () => {
    assert.ok(bundle.includes('localStorage'))
    assert.ok(bundle.includes('document.cookie'))
    assert.ok(bundle.includes('sessionRestore'))
    assert.ok(bundle.includes('sessionSave'))
  })

  it('confines the login snapshot to the DeepSeek origin', () => {
    // The guest starts on about:blank#<lease>, where localStorage throws and
    // document.cookie is empty. Saving that would erase the real snapshot, so
    // both directions must be origin-guarded.
    assert.ok(bundle.includes('function onDeepSeekOrigin'))
    assert.ok(bundle.includes("new URL(element.getURL()).hostname === 'chat.deepseek.com'"))
    // Save is refused off-origin.
    assert.match(
      bundle,
      /async function saveGuestSession[\s\S]{0,400}?if \(!onDeepSeekOrigin\(guest\.element\)\) return/,
    )
    // Restore is deferred, not consumed, off-origin.
    assert.match(
      bundle,
      /if \(record\.storageState !== 'pending'\) return\s*\n\s*if \(!onDeepSeekOrigin\(element\)\) return/,
    )
  })
})
