/**
 * Host-half route tests: drive `apply` against a stub `webServer` and call each
 * route with a fake request, so the HTTP surface is exercised the way the
 * browser half will actually hit it.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, before, describe, it } from 'node:test'

import { apply, ROUTES, setStateDir } from '../src/index.js'

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
      { seq: 2, role: 'user', text: 'my question' },
      { seq: 3, role: 'assistant', text: 'my answer' },
    ])
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
