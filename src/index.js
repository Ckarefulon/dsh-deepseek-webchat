/**
 * dsh-deepseek-webchat — host half.
 *
 * Four jobs, all of them things only the Host process can do:
 *
 * 1. **Read the current DSH Session's messages.** The browser half shows a
 *    picker, but it cannot read another part of the app's own conversation
 *    without going through a Host route, and the Host already owns the
 *    authoritative event log through `ctx.sessionQuery`. `readSession()` returns
 *    one Session's complete raw event log; this half reduces it to the
 *    user/assistant messages a human would recognise, with the system,
 *    developer, tool and injected-prompt events dropped.
 *
 * 2. **Bind DSH Sessions to DeepSeek conversations.** The mapping is a plain
 *    JSON file under the user's own DSH home. It is the browser half that learns
 *    a DeepSeek conversation id (from the guest's own URL), and the Host that
 *    persists it, because a browser guest has no durable storage of its own.
 *
 * 3. **Keep the DeepSeek login alive across restarts.** The shell hands every
 *    browser guest a **process-lifetime** session partition
 *    (`dsh-sidebar-browser-<uuid>`, no `persist:` prefix, a fresh name every
 *    run), so cookies and site storage die with the app. This half stores the
 *    guest's `localStorage` and `document.cookie`, captured by the browser half,
 *    and hands them back on the next run.
 *
 *    Note the honest limit: this Host runs as a plain Node child process
 *    (`ELECTRON_RUN_AS_NODE=1`), *not* inside Electron, so it cannot reach
 *    `session.fromPartition(...).cookies` and cannot carry **HttpOnly** cookies.
 *    The DeepSeek web app keeps its credential in `localStorage.userToken` and
 *    sends it as a bearer token, so replaying site storage is what actually
 *    restores the login; the non-HttpOnly cookie string rides along. See the
 *    README's known limitations.
 *
 * 4. **Report what is reachable**, so the browser half can explain itself when
 *    the desktop guest bridge is absent (a plain `dsh web` profile).
 *
 * No agent tools, no model calls, no outbound network of its own.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Stable cordis plugin name. */
export const name = 'deepseek-webchat'

/** The web server is the only service this plugin needs. */
export const inject = ['webServer']

/** The page this plugin exists to show. */
export const PAGE_URL = 'https://chat.deepseek.com/'

/**
 * DeepSeek's own route table (read from its shipped bundle) is
 * `/a/:agentId/s/:sessionId`, and the default agent is `chat`. So a conversation
 * is addressable as a plain URL — no in-page JavaScript is needed to open one.
 */
export const AGENT_ID = 'chat'

/**
 * Build the DeepSeek conversation URL for one conversation id.
 * @param sessionId - DeepSeek conversation id.
 * @returns the absolute URL that opens that conversation.
 */
export function deepseekConversationUrl(sessionId) {
  return `${PAGE_URL}a/${AGENT_ID}/s/${encodeURIComponent(sessionId)}`
}

/**
 * Extract a DeepSeek conversation id from a chat.deepseek.com URL.
 * @param value - any URL string the guest reports.
 * @returns the conversation id, or undefined when the URL names none.
 */
export function deepseekSessionIdOf(value) {
  if (typeof value !== 'string' || value === '') return undefined
  let url
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.hostname !== 'chat.deepseek.com') return undefined
  const match = /^\/a\/[^/]+\/s\/([^/?#]+)\/?$/.exec(url.pathname)
  return match === null ? undefined : decodeURIComponent(match[1])
}

/** Route family; the browser half spells the same paths. */
export const ROUTES = {
  state: '/api/dsh-deepseek-webchat/state',
  messages: '/api/dsh-deepseek-webchat/messages',
  binding: '/api/dsh-deepseek-webchat/binding',
  sessionRestore: '/api/dsh-deepseek-webchat/session/restore',
  sessionSave: '/api/dsh-deepseek-webchat/session/save',
}

/**
 * The plugin's private state directory. Overridable so tests never touch the
 * real profile directory.
 */
let stateDirOverride = null

/**
 * @returns the directory holding this plugin's two JSON files.
 */
export function stateDir() {
  return stateDirOverride ?? join(homedir(), '.dsh', 'dsh-deepseek-webchat')
}

/** Point the state directory somewhere else (tests only). @param dir - absolute path. */
export function setStateDir(dir) {
  stateDirOverride = dir
}

/** @returns the DSH-Session → DeepSeek-conversation mapping file path. */
export function bindingsFile() {
  return join(stateDir(), 'bindings.json')
}

/** @returns the guest session snapshot file path. */
export function sessionFile() {
  return join(stateDir(), 'session.json')
}

/**
 * Read one JSON file, treating absence and corruption alike as "nothing saved".
 * @param file - absolute path.
 * @returns the parsed object, or null.
 */
export function readJsonFile(file) {
  try {
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Write one JSON file atomically, so a crash mid-write cannot leave a truncated
 * file that would read back as "nothing saved" and silently lose a login or a
 * whole set of bindings.
 * @param file - absolute path.
 * @param value - JSON-serialisable value.
 */
export function writeJsonFile(file, value) {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

//#region message extraction

/**
 * Plain text of one content-block array.
 *
 * Only `text` blocks contribute. `reasoning` is the model's private thinking and
 * is deliberately dropped, matching how the harness itself extracts searchable
 * text (see `extractSessionEventText` in @deepseek-ai/dsh-session-query).
 * @param content - a message's content array.
 * @returns the joined text.
 */
export function contentText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text.trim())
  }
  return parts.filter(Boolean).join('\n')
}

/**
 * Whether a `user/message` event is something the human actually typed.
 *
 * DSH records injected context — agent instructions, skill catalogs, goal
 * rounds, time context, compaction checkpoints, team and webhook deliveries —
 * as `user/message` events too, distinguished by `data.source.kind`. Only
 * `kind === 'user'` is the person at the keyboard, which is exactly the set the
 * acceptance criteria call "消息" and the privacy rules call "not system
 * prompts".
 * @param event - one raw session event.
 * @returns true for a human turn.
 */
export function isHumanUserMessage(event) {
  const source = event?.data?.source
  return typeof source === 'object' && source !== null && source.kind === 'user'
}

/**
 * Reduce one Session's raw event log to the messages a human would recognise.
 *
 * Both roles are kept because the point of the picker is to quote a
 * conversation; the caller decides what to tick.
 * @param events - raw events from `ctx.sessionQuery.readSession`.
 * @returns `{ seq, role, text }` rows in log order, empty messages dropped.
 */
export function extractMessages(events) {
  if (!Array.isArray(events)) return []
  const rows = []
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue
    if (event.type === 'user/message') {
      if (!isHumanUserMessage(event)) continue
      const text = contentText(event.data?.content)
      if (text !== '') rows.push({ seq: event.seq, role: 'user', text })
      continue
    }
    if (event.type === 'assistant/message') {
      const text = contentText(event.data?.message?.content)
      if (text !== '') rows.push({ seq: event.seq, role: 'assistant', text })
    }
  }
  return rows
}

//#endregion

//#region HTTP helpers

/**
 * Read and parse a JSON request body.
 * @param req - incoming request.
 * @param limit - maximum accepted byte length.
 * @returns the parsed body, or null when absent/oversized/malformed.
 */
export async function readJsonBody(req, limit = 4 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) return null
    chunks.push(chunk)
  }
  if (size === 0) return null
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

/**
 * Answer one request with JSON.
 * @param res - response to write.
 * @param status - HTTP status code.
 * @param body - JSON-serialisable body.
 */
export function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** @returns the value of one query parameter, or undefined. */
function queryParam(url, key) {
  try {
    return new URL(url, 'http://127.0.0.1').searchParams.get(key) ?? undefined
  } catch {
    return undefined
  }
}

//#endregion

//#region binding store

/** @returns the whole DSH-Session → DeepSeek-conversation map. */
export function readBindings() {
  const raw = readJsonFile(bindingsFile())
  const map = raw?.bindings
  return typeof map === 'object' && map !== null && !Array.isArray(map) ? map : {}
}

/**
 * @param dshSessionId - DSH Session id.
 * @returns the bound DeepSeek conversation id, or undefined.
 */
export function readBinding(dshSessionId) {
  const value = readBindings()[dshSessionId]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Record one binding. Rewriting the same pair is a no-op, so the browser half
 * can call this on every navigation without churning the disk.
 * @param dshSessionId - DSH Session id.
 * @param deepseekSessionId - DeepSeek conversation id.
 * @returns true when the file changed.
 */
export function writeBinding(dshSessionId, deepseekSessionId) {
  if (typeof dshSessionId !== 'string' || dshSessionId === '') return false
  if (typeof deepseekSessionId !== 'string' || deepseekSessionId === '') return false
  const bindings = readBindings()
  if (bindings[dshSessionId] === deepseekSessionId) return false
  bindings[dshSessionId] = deepseekSessionId
  writeJsonFile(bindingsFile(), { version: 1, bindings })
  return true
}

/**
 * Find which DSH Session owns a DeepSeek conversation.
 *
 * The browser half needs this before it can tell whether the guest is already
 * sitting in *this* Session's conversation or in one belonging to a Session the
 * user has since switched away from — the difference between leaving the page
 * alone and navigating it home.
 * @param deepseekSessionId - DeepSeek conversation id.
 * @returns the owning DSH Session id, or undefined.
 */
export function findOwner(deepseekSessionId) {
  if (typeof deepseekSessionId !== 'string' || deepseekSessionId === '') return undefined
  const bindings = readBindings()
  for (const [dshSessionId, value] of Object.entries(bindings)) {
    if (value === deepseekSessionId) return dshSessionId
  }
  return undefined
}

/**
 * Forget one binding, so the next visit starts a fresh DeepSeek conversation.
 * @param dshSessionId - DSH Session id.
 * @returns true when something was removed.
 */
export function deleteBinding(dshSessionId) {
  const bindings = readBindings()
  if (!(dshSessionId in bindings)) return false
  delete bindings[dshSessionId]
  writeJsonFile(bindingsFile(), { version: 1, bindings })
  return true
}

//#endregion

//#region guest session snapshot

/**
 * Persist the guest's own storage and cookie string.
 * @param storage - `[key, value]` pairs from the guest's localStorage.
 * @param cookie - the guest's `document.cookie`.
 * @returns the snapshot that was written.
 */
export function saveGuestSession(storage, cookie) {
  const snapshot = {
    version: 1,
    savedAt: new Date().toISOString(),
    storage: Array.isArray(storage)
      ? storage.filter(
        (pair) => Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string',
      )
      : [],
    cookie: typeof cookie === 'string' ? cookie : '',
  }
  writeJsonFile(sessionFile(), snapshot)
  return snapshot
}

/**
 * @returns the stored guest state, or null when nothing usable is saved.
 */
export function loadGuestSession() {
  const snapshot = readJsonFile(sessionFile())
  if (snapshot === null) return null
  const storage = Array.isArray(snapshot.storage) ? snapshot.storage : []
  const cookie = typeof snapshot.cookie === 'string' ? snapshot.cookie : ''
  if (storage.length === 0 && cookie === '') return null
  return { storage, cookie }
}

//#endregion

/**
 * Read one Session's pickable messages through the Host's own query service.
 * @param ctx - Host context.
 * @param sessionId - DSH Session id.
 * @returns the messages, or a reason they could not be read.
 */
async function readSessionMessages(ctx, sessionId) {
  const query = ctx.get('sessionQuery')
  if (query === undefined) {
    return { ok: false, error: 'this profile provides no sessionQuery service', messages: [] }
  }
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { ok: false, error: 'a session id is required', messages: [] }
  }
  try {
    const session = await query.readSession(sessionId)
    return { ok: true, error: '', messages: extractMessages(session?.events) }
  } catch (error) {
    return { ok: false, error: messageOf(error), messages: [] }
  }
}

/** @param error - anything thrown. @returns a readable message. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Register this plugin's routes.
 * @param ctx - Host context carrying `webServer`.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTES.state,
    handler: (req, res) => {
      json(res, 200, {
        ok: true,
        pageUrl: PAGE_URL,
        agentId: AGENT_ID,
        sessionQuery: ctx.get('sessionQuery') !== undefined,
        bindings: Object.keys(readBindings()).length,
        sessionSaved: readJsonFile(sessionFile()) !== null,
      })
    },
  }), 'deepseek-webchat: state route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTES.messages,
    handler: async (req, res) => {
      const sessionId = queryParam(req.url, 'sessionId')
      json(res, 200, await readSessionMessages(ctx, sessionId))
    },
  }), 'deepseek-webchat: messages route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTES.binding,
    handler: async (req, res) => {
      // One route serves read, write and forget, because all three are the same
      // mapping seen from different sides and splitting them would let the
      // browser half observe a half-applied state.
      if (req.method === 'GET') {
        // Forward lookup asks "which conversation does this Session own"; the
        // reverse one asks "whose conversation is this".
        const reverse = queryParam(req.url, 'deepseekSessionId')
        if (reverse !== undefined) {
          json(res, 200, { ok: true, dshSessionId: findOwner(reverse) ?? null })
          return
        }
        const sessionId = queryParam(req.url, 'sessionId')
        json(res, 200, { ok: true, deepseekSessionId: readBinding(sessionId) ?? null })
        return
      }
      const body = await readJsonBody(req)
      if (body === null) {
        json(res, 400, { ok: false, error: 'a JSON body is required' })
        return
      }
      if (body.forget === true) {
        json(res, 200, { ok: true, removed: deleteBinding(body.dshSessionId), deepseekSessionId: null })
        return
      }
      const changed = writeBinding(body.dshSessionId, body.deepseekSessionId)
      json(res, 200, { ok: true, changed, deepseekSessionId: body.deepseekSessionId })
    },
  }), 'deepseek-webchat: binding route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTES.sessionRestore,
    handler: (req, res) => {
      const saved = loadGuestSession()
      json(res, 200, {
        ok: true,
        storage: saved === null ? [] : saved.storage,
        cookie: saved === null ? '' : saved.cookie,
      })
    },
  }), 'deepseek-webchat: session restore route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTES.sessionSave,
    handler: async (req, res) => {
      const body = await readJsonBody(req)
      if (body === null) {
        json(res, 400, { ok: false, error: 'a JSON body is required' })
        return
      }
      const snapshot = saveGuestSession(body.storage, body.cookie)
      json(res, 200, { ok: true, storage: snapshot.storage.length, cookie: snapshot.cookie !== '' })
    },
  }), 'deepseek-webchat: session save route')
}
