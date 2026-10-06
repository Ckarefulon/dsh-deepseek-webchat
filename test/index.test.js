/**
 * Host-half tests: URL mapping, binding persistence, privacy filtering, and the
 * `lib/` mirror. Run with `npm test` (Node's built-in runner, no dependencies).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  AGENT_ID,
  contentText,
  deepseekConversationUrl,
  deepseekSessionIdOf,
  deleteBinding,
  extractMessages,
  findOwner,
  isHumanUserMessage,
  loadGuestSession,
  readBinding,
  readBindings,
  saveGuestSession,
  setStateDir,
  writeBinding,
} from '../src/index.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

let sandbox = ''

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'dsh-deepseek-webchat-'))
  setStateDir(sandbox)
})

after(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

describe('conversation urls', () => {
  it('builds the /a/<agent>/s/<id> route DeepSeek itself uses', () => {
    assert.equal(
      deepseekConversationUrl('abc-123'),
      `https://chat.deepseek.com/a/${AGENT_ID}/s/abc-123`,
    )
  })

  it('escapes a conversation id', () => {
    assert.equal(
      deepseekConversationUrl('a/b'),
      `https://chat.deepseek.com/a/${AGENT_ID}/s/a%2Fb`,
    )
  })

  it('reads the conversation id back out', () => {
    assert.equal(
      deepseekSessionIdOf(`https://chat.deepseek.com/a/${AGENT_ID}/s/abc-123`),
      'abc-123',
    )
    assert.equal(
      deepseekSessionIdOf(`https://chat.deepseek.com/a/${AGENT_ID}/s/abc-123?x=1`),
      'abc-123',
    )
  })

  it('ignores the root, other agents and other hosts', () => {
    assert.equal(deepseekSessionIdOf('https://chat.deepseek.com/'), undefined)
    assert.equal(deepseekSessionIdOf('https://chat.deepseek.com/a/chat'), undefined)
    assert.equal(deepseekSessionIdOf('https://chat.deepseek.com/sign_in'), undefined)
    assert.equal(deepseekSessionIdOf('https://evil.example/a/chat/s/x'), undefined)
    assert.equal(deepseekSessionIdOf('not a url'), undefined)
    assert.equal(deepseekSessionIdOf(''), undefined)
    assert.equal(deepseekSessionIdOf(undefined), undefined)
  })
})

describe('message extraction', () => {
  it('keeps only text blocks, dropping reasoning', () => {
    assert.equal(
      contentText([
        { type: 'reasoning', text: 'private thinking' },
        { type: 'text', text: 'the answer' },
        { type: 'tool-call', name: 'bash', arguments: '{}' },
      ]),
      'the answer',
    )
  })

  it('accepts only human turns', () => {
    assert.equal(isHumanUserMessage({ data: { source: { kind: 'user' } } }), true)
    assert.equal(isHumanUserMessage({ data: { source: { kind: 'agent-instructions' } } }), false)
    assert.equal(isHumanUserMessage({ data: { source: { kind: 'time-context' } } }), false)
    assert.equal(isHumanUserMessage({ data: {} }), false)
    assert.equal(isHumanUserMessage({}), false)
  })

  it('drops injected prompts, system, developer and tool events', () => {
    const rows = extractMessages([
      { seq: 1, type: 'user/message', data: { source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'SECRET INSTRUCTIONS' }] } },
      { seq: 2, type: 'system/message', data: { content: [{ type: 'text', text: 'system' }] } },
      { seq: 3, type: 'developer/message', data: { content: [{ type: 'text', text: 'developer' }] } },
      { seq: 4, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } },
      { seq: 5, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'hi there' }] } } },
      { seq: 6, type: 'tool/call', data: { name: 'bash', arguments: '{}' } },
      { seq: 7, type: 'tool/result', data: { content: [{ type: 'text', text: 'output' }] } },
    ])
    assert.deepEqual(rows, [
      { seq: 4, role: 'user', text: 'hello' },
      { seq: 5, role: 'assistant', text: 'hi there' },
    ])
  })

  it('skips empty messages and survives junk', () => {
    assert.deepEqual(extractMessages(null), [])
    assert.deepEqual(extractMessages([null, 7, { type: 'user/message' }]), [])
    assert.deepEqual(
      extractMessages([{ seq: 1, type: 'assistant/message', data: { message: { content: [] } } }]),
      [],
    )
  })
})

describe('bindings', () => {
  it('round-trips one Session', () => {
    assert.equal(readBinding('s1'), undefined)
    assert.equal(writeBinding('s1', 'ds-1'), true)
    assert.equal(readBinding('s1'), 'ds-1')
    // Rewriting the same pair is a no-op, so navigation can call it freely.
    assert.equal(writeBinding('s1', 'ds-1'), false)
  })

  it('keeps Sessions independent', () => {
    writeBinding('s2', 'ds-2')
    assert.equal(readBinding('s1'), 'ds-1')
    assert.equal(readBinding('s2'), 'ds-2')
    assert.equal(findOwner('ds-2'), 's2')
    assert.equal(findOwner('ds-1'), 's1')
    assert.equal(findOwner('ds-nope'), undefined)
  })

  it('forgets one binding without touching the others', () => {
    assert.equal(deleteBinding('s2'), true)
    assert.equal(deleteBinding('s2'), false)
    assert.equal(readBinding('s2'), undefined)
    assert.equal(readBinding('s1'), 'ds-1')
  })

  it('rejects nonsense keys and values', () => {
    assert.equal(writeBinding('', 'ds'), false)
    assert.equal(writeBinding('s3', ''), false)
    assert.equal(writeBinding(undefined, undefined), false)
    assert.equal(readBinding(undefined), undefined)
  })

  it('survives a corrupt file instead of throwing', () => {
    writeFileSync(join(sandbox, 'bindings.json'), '{ not json', 'utf8')
    assert.deepEqual(readBindings(), {})
    assert.equal(readBinding('s1'), undefined)
  })
})

describe('guest session snapshot', () => {
  it('round-trips storage and cookies', () => {
    saveGuestSession([['userToken', 'tok'], ['__appKit_userInfo', '{}']], 'a=1; b=2')
    const loaded = loadGuestSession()
    assert.deepEqual(loaded.storage, [['userToken', 'tok'], ['__appKit_userInfo', '{}']])
    assert.equal(loaded.cookie, 'a=1; b=2')
  })

  it('reports nothing saved rather than an empty shell', () => {
    saveGuestSession([], '')
    assert.equal(loadGuestSession(), null)
  })

  it('drops malformed storage entries', () => {
    saveGuestSession([['ok', 'v'], ['bad'], 'nope', [1, 2], [null, null]], '')
    assert.deepEqual(loadGuestSession().storage, [['ok', 'v']])
  })
})

describe('published lib/ mirror', () => {
  it('matches src/, so a git install needs no build step', () => {
    for (const relative of ['index.js', join('client', 'index.js')]) {
      const source = readFileSync(join(root, 'src', relative), 'utf8')
      const published = readFileSync(join(root, 'lib', relative), 'utf8')
      assert.equal(
        published,
        source,
        `lib/${relative} is out of date; run: npm run build`,
      )
    }
  })

  it('registers the browser bundle under the manifest name', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const client = readFileSync(join(root, 'lib', 'client', 'index.js'), 'utf8')
    assert.ok(
      client.includes(`id: '${manifest.name}'`),
      'the browser bundle must load under the manifest name verbatim',
    )
    assert.match(client, /exports\.apply = apply/)
    assert.match(client, /exports\.inject = inject/)
    assert.match(client, /return module\.exports/)
  })

  it('patches the profile with the manifest name verbatim', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
    assert.ok(
      patch.includes(`name: '${manifest.name}'`),
      'the bundle patch must insert the manifest name verbatim',
    )
  })

  it('ships no lifecycle script, so a git install needs no build approval', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    // `prepare`/`install` are what pnpm blocks behind allowBuilds; with lib/
    // committed there is nothing left for them to do.
    for (const script of ['prepare', 'preinstall', 'install', 'postinstall']) {
      assert.equal(
        manifest.scripts?.[script],
        undefined,
        `package.json must not declare a "${script}" script`,
      )
    }
  })
})
