/**
 * Host-half route tests: drive `apply` against a stub `webServer` and call each
 * route with a fake request, so the HTTP surface is exercised the way the
 * browser half will actually hit it.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { apply, ROUTES, setStateDir } from '../src/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let sandbox = ''

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'dsh-dswc-routes-'))
  setStateDir(sandbox)
})

after(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

/**
 * Build a stub host context and run `apply`, collecting the routes.
 * @param sessionQuery - optional `sessionQuery` service.
 * @returns `{ routes, call }`.
 */
function hostWith(sessionQuery) {
  const routes = new Map()
  const ctx = {
    get: (service) => (service === 'sessionQuery' ? sessionQuery : undefined),
    webServer: {
      register: (route) => {
        routes.set(route.path, route)
        return () => {}
      },
    },
    effect: (fn) => {
      fn()
      return () => {}
    },
  }
  apply(ctx)
  return {
    routes,
    /**
     * Invoke one route.
     * @param path - the registered path.
     * @param options - `{ method, body, query }`.
     * @returns `{ status, body }`.
     */
    async call(path, options = {}) {
      const route = routes.get(path)
      assert.notEqual(route, undefined, `no route registered at ${path}`)
      const query = options.query === undefined ? '' : `?${options.query}`
      const payload = options.body === undefined ? null : JSON.stringify(options.body)
      const req = Readable.from(payload === null ? [] : [Buffer.from(payload)])
      req.method = options.method ?? 'GET'
      req.url = `${path}${query}`
      req.headers = { 'content-type': 'application/json' }
      let status = 0
      let text = ''
      const res = {
        writeHead: (code) => {
          status = code
        },
        end: (chunk) => {
          text = chunk ?? ''
        },
      }
      await route.handler(req, res)
      return { status, body: text === '' ? null : JSON.parse(text) }
    },
  }
}

describe('registered routes', () => {
  it('registers exactly the documented surface', () => {
    const { routes } = hostWith(undefined)
    assert.deepEqual(
      [...routes.keys()].sort(),
      Object.values(ROUTES).sort(),
    )
  })

  it('registers every route as an exact path', () => {
    const { routes } = hostWith(undefined)
    for (const route of routes.values()) assert.equal(route.kind, 'exact')
  })

  it('declares every host route in the browser half too', () => {
    // The halves keep separate copies of the route table, and a missing entry
    // fails silently: the browser half calls `fetch(undefined)`, which rejects
    // into a catch that swallows it, so the feature just never happens. That is
    // exactly how the diagnostics channel shipped dead once.
    const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
    for (const [name, path] of Object.entries(ROUTES)) {
      assert.ok(
        bundle.includes(`'${path}'`),
        `the browser half does not declare the "${name}" route (${path})`,
      )
    }
  })
})

describe('state route', () => {
  it('reports what the panel needs to describe itself', async () => {
    const host = hostWith({ readSession: async () => ({ events: [] }) })
    const { status, body } = await host.call(ROUTES.state)
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.pageUrl, 'https://chat.deepseek.com/')
    assert.equal(body.agentId, 'chat')
    assert.equal(body.sessionQuery, true)
  })

  it('says so when the profile has no sessionQuery', async () => {
    const host = hostWith(undefined)
    const { body } = await host.call(ROUTES.state)
    assert.equal(body.sessionQuery, false)
  })
})

describe('messages route', () => {
  it('reduces a session log to human messages', async () => {
    const host = hostWith({
      readSession: async () => ({
        events: [
          { seq: 1, type: 'user/message', data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'INJECTED' }] } },
          { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'my question' }] } },
          { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'my answer' }] } } },
        ],
      }),
    })
    const { status, body } = await host.call(ROUTES.messages, {
      query: 'sessionId=s1',
    })
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.deepEqual(body.messages, [
      { seq: 2, role: 'user', kind: 'user', text: 'my question' },
      { seq: 3, role: 'assistant', kind: 'assistant', text: 'my answer' },
    ])
  })

  it('does not re-read an unchanged session on every open', async () => {
    // readSession parses the whole log — measured at 2.3 seconds for a 3.6 MB
    // session, synchronous work on the host — and the picker did it on every open,
    // which is what made opening it look like a freeze. The log only grows, so the
    // extracted rows stay valid while the event count is unchanged.
    let reads = 0
    const events = [
      { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'one' }] } },
    ]
    const host = hostWith({
      readSession: async () => {
        reads += 1
        return { events }
      },
    })
    const first = await host.call(ROUTES.messages, { query: 'sessionId=cache-1' })
    assert.equal(first.body.cached, false)
    assert.equal(reads, 1)

    const second = await host.call(ROUTES.messages, { query: 'sessionId=cache-1' })
    assert.equal(second.body.cached, true)
    assert.equal(reads, 2, 'readSession is still consulted, to compare the count')
    assert.deepEqual(second.body.messages, first.body.messages)
  })

  it('re-reads once the session has grown', async () => {
    const events = [
      { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'one' }] } },
    ]
    const host = hostWith({ readSession: async () => ({ events }) })
    await host.call(ROUTES.messages, { query: 'sessionId=cache-2' })
    events.push({ seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'two' }] } })
    const grown = await host.call(ROUTES.messages, { query: 'sessionId=cache-2' })
    assert.equal(grown.body.cached, false)
    assert.equal(grown.body.messages.length, 2)
  })

  it('lists the machinery only when asked for advanced rows', async () => {
    const events = [
      { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
      { seq: 2, type: 'assistant/message', data: { message: { content: [
        { type: 'reasoning', text: 'thinking' },
        { type: 'text', text: 'ok' },
      ] } } },
      { seq: 3, type: 'tool/call', data: { name: 'bash', callId: 'c', arguments: '{}' } },
    ]
    const host = hostWith({ readSession: async () => ({ events }) })
    const plain = await host.call(ROUTES.messages, { query: 'sessionId=s1' })
    assert.deepEqual(plain.body.messages.map((row) => row.kind), ['user', 'assistant'])
    const rich = await host.call(ROUTES.messages, { query: 'sessionId=s1&advanced=1' })
    assert.deepEqual(rich.body.messages.map((row) => row.kind), ['user', 'assistant', 'reasoning', 'tool-call'])
  })

  it('explains a missing session id rather than throwing', async () => {
    const host = hostWith({ readSession: async () => ({ events: [] }) })
    const { status, body } = await host.call(ROUTES.messages)
    assert.equal(status, 200)
    assert.equal(body.ok, false)
    assert.match(body.error, /session id/)
  })

  it('explains an unreadable session rather than throwing', async () => {
    const host = hostWith({
      readSession: async () => {
        throw new Error('no such session')
      },
    })
    const { status, body } = await host.call(ROUTES.messages, { query: 'sessionId=gone' })
    assert.equal(status, 200)
    assert.equal(body.ok, false)
    assert.equal(body.error, 'no such session')
  })
})

describe('binding route', () => {
  it('writes, reads back, and reverses a binding', async () => {
    const host = hostWith(undefined)
    const written = await host.call(ROUTES.binding, {
      method: 'POST',
      body: { dshSessionId: 'route-s1', deepseekSessionId: 'ds-route-1' },
    })
    assert.equal(written.status, 200)
    assert.equal(written.body.ok, true)
    assert.equal(written.body.changed, true)

    const forward = await host.call(ROUTES.binding, { query: 'sessionId=route-s1' })
    assert.equal(forward.body.deepseekSessionId, 'ds-route-1')

    const reverse = await host.call(ROUTES.binding, { query: 'deepseekSessionId=ds-route-1' })
    assert.equal(reverse.body.dshSessionId, 'route-s1')
  })

  it('reports an unknown conversation as unowned', async () => {
    const host = hostWith(undefined)
    const { body } = await host.call(ROUTES.binding, { query: 'deepseekSessionId=nobody' })
    assert.equal(body.dshSessionId, null)
  })

  it('forgets on request', async () => {
    const host = hostWith(undefined)
    await host.call(ROUTES.binding, {
      method: 'POST',
      body: { dshSessionId: 'route-s2', deepseekSessionId: 'ds-route-2' },
    })
    const forgotten = await host.call(ROUTES.binding, {
      method: 'POST',
      body: { dshSessionId: 'route-s2', forget: true },
    })
    assert.equal(forgotten.body.removed, true)
    const forward = await host.call(ROUTES.binding, { query: 'sessionId=route-s2' })
    assert.equal(forward.body.deepseekSessionId, null)
  })

  it('rejects a body-less write', async () => {
    const host = hostWith(undefined)
    const { status, body } = await host.call(ROUTES.binding, { method: 'POST' })
    assert.equal(status, 400)
    assert.equal(body.ok, false)
  })
})

describe('diagnostics route', () => {
  it('reports nothing before the browser half has said anything', async () => {
    const host = hostWith(undefined)
    const { status, body } = await host.call(ROUTES.diag)
    assert.equal(status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.diagnostics, null)
    assert.deepEqual(body.recent, [])
  })

  it('stores what the browser half posts, and reads it back', async () => {
    const host = hostWith(undefined)
    await host.call(ROUTES.diag, {
      method: 'POST',
      body: { shown: 3, hidden: 2, mounts: 1, events: [{ t: 100, kind: 'show' }] },
    })
    const { body } = await host.call(ROUTES.diag)
    assert.equal(body.diagnostics.shown, 3)
    assert.equal(body.diagnostics.hidden, 2)
    // The host stamps it, so a stale snapshot is recognisable.
    assert.equal(typeof body.diagnostics.at, 'number')
  })

  it('filters events by ?since so a reproduced flicker reads clean', async () => {
    const host = hostWith(undefined)
    await host.call(ROUTES.diag, {
      method: 'POST',
      body: { events: [{ t: 100, kind: 'old' }, { t: 300, kind: 'new' }] },
    })
    const { body } = await host.call(ROUTES.diag, { query: 'since=200' })
    assert.deepEqual(body.recent, [{ t: 300, kind: 'new' }])
  })

  it('rejects a body-less post', async () => {
    const host = hostWith(undefined)
    const { status } = await host.call(ROUTES.diag, { method: 'POST' })
    assert.equal(status, 400)
  })
})

describe('session snapshot routes', () => {
  it('saves and restores the guest login state', async () => {
    const host = hostWith(undefined)
    const saved = await host.call(ROUTES.sessionSave, {
      method: 'POST',
      body: { storage: [['userToken', 'tok']], cookie: 'sid=1' },
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.storage, 1)
    assert.equal(saved.body.cookie, true)

    const restored = await host.call(ROUTES.sessionRestore, { method: 'POST' })
    assert.deepEqual(restored.body.storage, [['userToken', 'tok']])
    assert.equal(restored.body.cookie, 'sid=1')
  })

  it('rejects a body-less save', async () => {
    const host = hostWith(undefined)
    const { status } = await host.call(ROUTES.sessionSave, { method: 'POST' })
    assert.equal(status, 400)
  })
})
