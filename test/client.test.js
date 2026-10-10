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

  it('is valid JavaScript and valid UTF-8', () => {
    // A tool that rewrites the file without preserving its encoding turns every
    // non-ASCII character into mojibake, which is *also* a syntax error once a
    // byte lands somewhere a string literal cannot hold it. client-modules
    // composes this bundle at Host boot, so that fails the whole harness rather
    // than just this plugin — worth an explicit, named check rather than a
    // generic parse failure somewhere downstream.
    const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
    assert.equal(source.includes('\uFFFD'), false, 'the bundle contains U+FFFD replacement characters')
    // Sequences this machine's PowerShell round-trip produced from UTF-8 Chinese.
    assert.equal(/鐗|缃戦|鈥|锛|鍜|浣|绋/.test(source), false, 'the bundle contains mojibake')
    assert.ok((source.match(/[\u4e00-\u9fff]/g) ?? []).length > 200, 'the Chinese copy is missing')
    // Parsing is the real syntax test; `loadBundle` above only exercises the path
    // it executes, and a broken character can sit outside that.
    assert.doesNotThrow(() => new Function(source))
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

describe('composer filling and sending', () => {
  it('fills through the native value setter, not a plain assignment', () => {
    // The script is built inline in the bundle; assert on its text so a future
    // edit cannot go back to writing `.value`, which React ignores.
    assert.ok(bundle.includes('dispatchEvent(new Event("input"'))
    assert.ok(bundle.includes('Object.getOwnPropertyDescriptor'))
  })

  it('never submits the form itself', () => {
    assert.equal(/\.submit\(\)|requestSubmit/.test(bundle), false)
  })

  it('sends through DeepSeek own Enter handler', () => {
    // Its composer runs onKeyDown and, for a plain Enter, calls the same function
    // its send button calls — so a bubbling Enter is the user's own code path.
    // Inventing a shortcut, or guessing the button's hashed class, would not be.
    assert.ok(bundle.includes('new KeyboardEvent("keydown"'))
    assert.ok(bundle.includes('key: "Enter"'))
    assert.ok(bundle.includes('bubbles: true, cancelable: true, composed: true'))
  })

  it('treats a cleared composer as the receipt, with the button as fallback', () => {
    // DeepSeek empties its textarea once a send is accepted, so that — not an
    // assumption that the click worked — is what we report on.
    assert.ok(bundle.includes('empty: value.trim()'))
    assert.ok(bundle.includes('/send|submit|发送/i'))
    assert.ok(bundle.includes('found: true'))
  })

  it('re-checks the composer before clicking, so it cannot send twice', () => {
    assert.ok(bundle.includes('composerCleared'))
    assert.ok(bundle.includes('not-sent'))
  })

  it('targets the class DeepSeek actually renders', () => {
    assert.ok(bundle.includes('textarea.ds-textarea__textarea'))
  })
})

describe('picker affordances', () => {
  it('marks every row kind with artwork from the shell icon set', () => {
    // One fingerprint per glyph, copied from dsh-client-ui-primitives. Checking
    // the leading path data is what proves all ten shipped, rather than trusting
    // that the map was filled in.
    const fingerprints = [
      'M8 8.25C9.51878',        // user
      'M5.875 3C5.875',         // assistant
      'M5.75 6.69646',          // question
      'M2.25 8.5L5.49732',      // answer
      'M10.2854 5.71481',       // reasoning
      'M6.27612 1.5L4.52612',   // tool-call
      'M11.8798 9.55347',       // tool-result
      'M3.75 6.25C4.7165',      // todo
      'M10.3329 7.91346',       // command
      'M8 1.5C8.85359',         // summary
    ]
    for (const path of fingerprints) assert.ok(bundle.includes(path), path)
    assert.ok(bundle.includes("viewBox: '0 0 16 16'"))
  })

  it('explains the quoted context to DeepSeek before sending it', () => {
    assert.ok(bundle.includes('picker.preambleText'))
  })

  it('offers the last few rows as one action', () => {
    assert.ok(bundle.includes('action.last'))
    assert.ok(bundle.includes('slice(Math.max(0, rows.length - lastN))'))
  })

  it('scrolls the list to the newest rows', () => {
    assert.ok(bundle.includes('node.scrollTop = node.scrollHeight'))
  })

  it('clears the selection once the content has been pushed', () => {
    assert.ok(bundle.includes('setSelected(new Set())'))
  })

  it('pages the list instead of mounting every row at once', () => {
    // A session can hold hundreds of rows (one measured at 555, ~168 KB) and
    // building plus laying out all of them blocks the main thread — 73 ms for
    // 555, mostly the forced layout. The newest page mounts; earlier rows come in
    // on request.
    assert.ok(bundle.includes('const LIST_PAGE_SIZE = 10'))
    assert.ok(bundle.includes('messages.slice(start)'), 'the window must be a slice')
    assert.ok(bundle.includes('setPageSize((size) => size + LIST_PAGE_SIZE)'), 'no way to grow it')
    assert.ok(bundle.includes("t('action.loadEarlier')"))
    // Selection is by seq, so the bulk actions still cover the whole session.
    assert.ok(bundle.includes('new Set((messages ?? []).map((row) => row.seq))'))
  })

  it('holds the reader place when earlier rows are inserted above', () => {
    // Growing the window must not jump to the bottom, or the position the reader
    // scrolled to in order to click the button is thrown away.
    assert.ok(bundle.includes('anchoredRef'), 'the anchor is gone')
    assert.ok(bundle.includes('data-seq'), 'rows are not addressable')
    // The anchor is consumed, so a later fetch still scrolls to the newest rows.
    assert.ok(bundle.includes('anchoredRef.current = null'))
    assert.ok(bundle.includes('setPageSize(LIST_PAGE_SIZE)'), 'a new fetch must start at page one')
  })
})

describe('following the DSH Session', () => {
  it('does not re-focus on every guest notification', () => {
    // The follow effect used to depend on `version`, which every notify() bumps —
    // and notify() fires from the guest's own navigation events. That made the
    // effect navigate, which notified, which re-ran the effect: an endless
    // navigate/notify ping-pong the user saw as the panel flickering. It must
    // depend on the session alone.
    // Anchor on the call site, not on the function name: the definition is a
    // separate occurrence and would otherwise be counted as a second effect.
    const at = bundle.indexOf('await focusSession(sessionId)')
    assert.ok(at > -1)
    // Walk back to the effect that owns this call, then forward to its deps.
    const start = bundle.lastIndexOf('React.useEffect(', at)
    assert.ok(start > -1)
    assert.ok(start < at)
    const tail = bundle.slice(at, at + 400)
    const deps = tail.match(/\}, \[([^\]]*)\]\)/)
    assert.ok(deps !== null, 'could not find the dependency list')
    assert.equal(deps[1].includes('version'), false, 'the follow effect must not depend on version')
    assert.ok(deps[1].includes('sessionId'))
  })

  it('never lets a navigation event clear the settle marker', () => {
    // observeUrl trusts a URL only once it has read it twice. Clearing the marker
    // on every navigation event meant a still page never settled and its
    // conversation was never bound.
    const at = bundle.indexOf("'did-navigate', 'did-navigate-in-page'")
    assert.ok(at > -1)
    const body = bundle.slice(at, at + 400)
    assert.equal(body.includes('lastSeenUrl = '), false)
  })

  it('reaches a bound conversation from anywhere else', () => {
    // Including DeepSeek's root, which does not always redirect into one.
    assert.ok(bundle.includes('navigate(conversationUrl(bound))'))
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
    // The claim is taken from the host's echo, not from the request, so a write
    // the host refuses is not cached as though it had succeeded.
    assert.ok(bundle.includes('boundPairs.add(dshSessionId'))
  })

  it('clears that cache when a binding is forgotten', () => {
    assert.ok(bundle.includes('forgetBoundPairs'))
    // Canonicalised, or the entry survives and the next visit looks bound.
    assert.ok(bundle.includes('const canonical = canonicalSessionId(dshSessionId)'))
  })

  it('restores an existing binding instead of adopting what is on screen', () => {
    // Adopting an unowned conversation used to be checked first, so a Session
    // that already owned one could have its binding silently replaced: DeepSeek
    // redirects its root into the user's last conversation, so the guest often
    // arrives somewhere unowned, and that branch would re-point the Session
    // instead of returning it to its own conversation. That is the "binding
    // failed" symptom.
    const at = bundle.indexOf('async function focusSession(')
    assert.ok(at > -1)
    const body = bundle.slice(at, bundle.indexOf('async function ownerOf('))
    const boundCheck = body.indexOf('if (bound !== null)')
    const adoptCheck = body.indexOf('if (owner === null)')
    assert.ok(boundCheck > -1 && adoptCheck > -1, 'both branches must exist')
    assert.ok(boundCheck < adoptCheck, 'the existing binding must be honoured first')
    assert.ok(
      /if \(currentId !== bound\) navigate\(conversationUrl\(bound\)\)/.test(body),
      'a bound Session must be navigated back to its conversation',
    )
  })

  it('never lets the URL poll steal a conversation that is already owned', () => {
    // observeUrl runs every two seconds. Binding unconditionally there re-pointed
    // the active Session at whatever the guest was showing, which during a restore
    // is the old conversation — the navigation has not landed yet — so the poll
    // undid the restore.
    const at = bundle.indexOf('function observeUrl(')
    assert.ok(at > -1)
    const body = bundle.slice(at, bundle.indexOf('async function adoptIfUnowned('))
    assert.equal(
      /void bind\(activeSessionId/.test(body),
      false,
      'observeUrl must not bind unconditionally',
    )
    assert.ok(body.includes('adoptIfUnowned'), 'observeUrl must go through the unowned-only path')
    const adopt = bundle.slice(
      bundle.indexOf('async function adoptIfUnowned('),
      bundle.indexOf('async function focusSession('),
    )
    assert.ok(
      /if \(owner !== null && owner !== dshSessionId\) return/.test(adopt),
      'a conversation owned by another Session must not be adopted',
    )
  })

  it('compares Session ids in one canonical form', () => {
    // DSH hands out both `e07a9659-…` and `session-e07a9659-…`; comparing the
    // raw form against the host's canonical answer silently mismatched.
    assert.ok(bundle.includes("trimmed.startsWith('session-')"))
    assert.ok(bundle.includes("trimmed.slice('session-'.length)"))
  })

  it('snapshots the guest login state to the host', () => {
    assert.ok(bundle.includes('localStorage'))
    assert.ok(bundle.includes('document.cookie'))
    assert.ok(bundle.includes('sessionRestore'))
    assert.ok(bundle.includes('sessionSave'))
  })

  it('never parks the guest from an effect that can re-run on guest state', () => {
    // This effect tears down with hideOverlay() and re-runs with showOverlay(),
    // so re-running it is a hide/show cycle on a <webview> — a visible flicker.
    // It must depend on the picker alone, never on `version`, which is bumped by
    // every notify().
    const at = bundle.indexOf('const update = () => {')
    assert.ok(at > -1)
    // Anchor on the effect's own teardown rather than a fixed window: the body
    // grows as the effect gains instrumentation, and a byte count silently starts
    // matching the wrong `}, [...])` once it does.
    const tail = bundle.slice(at, at + 4000)
    const deps = tail.match(/\}, \[([^\]]*)\]\)/)
    assert.ok(deps !== null, 'could not find the parking effect dependencies')
    assert.equal(deps[1].includes('version'), false, 'parking must not depend on version')
    assert.ok(deps[1].includes('pickerOpen'))
  })

  it('sizes the guest before it is shown', () => {
    // The container is position:fixed with a white background, and a block-level
    // fixed box with width:auto spans the whole viewport. Showing it before its
    // geometry is set paints a full-window white slab over the app — the "whole
    // page flashes" symptom.
    const at = bundle.indexOf('function showOverlay(')
    assert.ok(at > -1)
    const body = bundle.slice(at, bundle.indexOf('function setOverlaySuppressed'))
    const setWidth = body.indexOf('style.width = width')
    const show = body.indexOf("style.display = 'block'")
    assert.ok(setWidth > -1 && show > -1, 'could not find both writes')
    assert.ok(setWidth < show, 'geometry must be written before the guest is shown')
    // A zero-sized pane is not parked on at all.
    assert.ok(body.includes('if (!(rect.width > 0) || !(rect.height > 0)) return'))
  })

  it('drives visibility from the tab record, not from measuring the pane', () => {
    // The flicker was a feedback loop: the guest sits in a position:fixed
    // container covering the host element, so showing it could make that element
    // measure empty, which hid the guest, which made it measure fine again. A
    // signal derived from the thing it controls oscillates. The sidebar already
    // publishes `tab.visible`, so the parking code must consult that instead.
    assert.ok(bundle.includes('tabInfo?.tab?.visible'), 'the tab visibility flag is not read')
    const at = bundle.indexOf('const update = () => {')
    assert.ok(at > -1)
    const body = bundle.slice(at, at + 1400)
    // A zero rectangle must not hide: it means "not laid out yet".
    assert.equal(
      /not-laid-out[\s\S]{0,200}?hideOverlay\(\)/.test(body),
      false,
      'an empty measurement must not hide the guest',
    )
    assert.ok(body.includes('why: \'not-laid-out\''))
  })

  it('hides the guest when the tab is not the one on screen', () => {
    const at = bundle.indexOf('React.useEffect(() => {')
    const park = bundle.indexOf('const update = () => {')
    assert.ok(park > -1)
    const head = bundle.slice(Math.max(0, park - 700), park)
    assert.ok(
      /if \(!tabVisible\) \{[\s\S]{0,80}?hideOverlay\(\)/.test(head),
      'a hidden tab must hide the guest',
    )
    // And it must re-park when the tab comes back.
    const deps = bundle.slice(park, park + 4000).match(/\}, \[([^\]]*)\]\)/)
    assert.ok(deps !== null)
    assert.ok(deps[1].includes('tabVisible'), 'the parking effect must follow tab visibility')
    assert.ok(deps[1].includes('pickerOpen'))
  })

  it('rounds the measured rectangle before comparing it to the style', () => {
    // `getBoundingClientRect()` returns fractions (705.4000244140625) while the
    // style object returns the browser's normalised form. Comparing the raw float
    // string against that never matches, so every pass rewrote all four
    // properties — and on a <webview> a geometry write re-composites. That was
    // four writes a second, which is a flicker, on a rectangle that had not
    // actually changed at all. Rounding makes an unchanged rect compare equal.
    const at = bundle.indexOf('function showOverlay(')
    assert.ok(at > -1)
    const body = bundle.slice(at, bundle.indexOf('function setOverlaySuppressed'))
    for (const axis of ['rect.left', 'rect.top', 'rect.width', 'rect.height']) {
      assert.ok(
        body.includes(`Math.round(${axis})`),
        `${axis} must be rounded before it is written`,
      )
    }
    assert.equal(
      /const (left|top|width|height) = rect\.(left|top|width|height) \+ 'px'/.test(body),
      false,
      'a raw fractional rect is being written again',
    )
  })

  it('takes the container out of the page layout', () => {
    // What made the rectangle unreliable in the first place.
    const at = bundle.indexOf('[' + "' + OVERLAY_ATTR + '" + ']')
    assert.ok(at > -1)
    assert.ok(bundle.includes('contain:layout size paint style'))
  })

  it('injects the stylesheet before the container can exist', () => {
    // Without the position:fixed rule the container is an ordinary block-level
    // div, so a bare one on <body> claims the full document width and shoves the
    // app sideways. It must therefore never be created unstyled.
    const at = bundle.indexOf('function overlayContainer()')
    assert.ok(at > -1)
    const body = bundle.slice(at, at + 600)
    assert.ok(body.includes('ensureStyle()'), 'overlayContainer must inject the sheet first')
    assert.ok(body.includes("box.style.display = 'none'"), 'the container must start hidden')
  })

  it('keeps hide and show idempotent so a redundant pass cannot blink', () => {
    // Re-setting a property that already holds that value on a <webview>'s
    // container can still re-composite, which reads as a flicker.
    const at = bundle.indexOf('function hideOverlay()')
    assert.ok(at > -1)
    const body = bundle.slice(at, bundle.indexOf('function showOverlay('))
    assert.ok(body.includes("if (guest.container.style.display === 'none')"), 'hide must check first')
    assert.ok(body.indexOf('return') < body.indexOf("style.display = 'none'"), 'the check must return early')
    assert.ok(bundle.includes("if (style.display !== 'block') {"))
  })

  it('does not blank the message list on a guest notification', () => {
    // Every pass of the fetch effect starts by setting the list to null, so
    // depending on `version` wiped the list whenever a binding landed.
    const at = bundle.indexOf('setMessages(null)')
    assert.ok(at > -1)
    const tail = bundle.slice(at, at + 2600)
    const deps = tail.match(/\}, \[([^\]]*)\]\)/)
    assert.ok(deps !== null, 'could not find the message effect dependencies')
    assert.equal(deps[1].includes('version'), false, 'the message fetch must not depend on version')
    assert.ok(deps[1].includes('reload'))
  })

  it('has an explicit re-read control of its own', () => {
    assert.ok(bundle.includes('setReload((value) => value + 1)'))
  })

  it('coalesces a burst of notifications into one render', () => {
    assert.ok(bundle.includes('function notifySoon'))
    assert.ok(bundle.includes('queueMicrotask'))
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
