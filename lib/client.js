/**
 * dsh-deepseek-webchat — browser half.
 *
 * A sidebar tab that shows the **real** chat.deepseek.com web app and lets you
 * push selected DSH messages into it by hand.
 *
 * ## Why this is not an iframe
 *
 * `chat.deepseek.com` answers with `Content-Security-Policy: frame-ancestors
 * 'none'`, so an `<iframe>` is refused by the page itself. The only supported
 * way in is the desktop shell's own browser guest channel: this bundle asks
 * `globalThis.dshDesktop.browser.acquire(workspace)` for a reservation, then
 * attaches a `<webview>` whose `src` is `about:blank#<lease>` and whose
 * `partition` is the one the shell issued. The shell's `will-attach-webview`
 * matches the lease, rewrites the element with hardened web preferences and
 * lets the navigation through. That is the same channel the built-in side-card
 * browser uses, so `frame-ancestors` never enters into it.
 *
 * ## Why the guest lives outside React
 *
 * A `<webview>` is destroyed when it leaves the document. If the slot owned it,
 * every look at another tab would tear down the page and reload it — losing a
 * half-typed question and re-running the site's boot. So the element lives in a
 * container this plugin owns at the document root, and the slot's body only
 * *measures* its area: the persistent guest is positioned onto that rectangle
 * while this tab is showing, and hidden when it is not. The tab type declares
 * `keepMounted: true` so the body itself survives tab switches and can keep
 * reporting that rectangle.
 *
 * ## One DeepSeek conversation per DSH Session
 *
 * DeepSeek's own routes (read from its shipped bundle) are
 * `/a/:agentId/s/:sessionId`, so a conversation is addressable as a plain URL.
 * The mapping DSH Session → DeepSeek conversation id is learned by watching the
 * guest's URL (the id only appears once the first message is sent, because
 * DeepSeek creates conversations lazily) and is persisted by the host half,
 * which is where a durable file can live.
 *
 * ## What this half never does
 *
 * It never sends anything to DeepSeek on its own. Selecting messages composes a
 * blockquote and *fills the composer*; pressing Enter is the human's move. It
 * never reads a DeepSeek answer back into the DSH conversation, and it never
 * quotes system, developer or injected-prompt events — those are filtered by the
 * host half before they reach the picker.
 */

window.__ModuleLoader__.load({
	id: '@ckarefulon/dsh-deepseek-webchat',
	factory: (require) => {
		// The loader passes `require` but no `module`, so every bundle declares
		// its own CommonJS-ish pair, exactly as the shipped bundles do.
		const module = { exports: {} }
		const exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')

		const h = React.createElement

		/** Locale namespace, and the i18n key for this plugin's copy. */
		const NS = '@ckarefulon/dsh-deepseek-webchat'

		/** The tab type id; the slot dispatch key for this plugin's body. */
		const TAB_ID = '@ckarefulon/dsh-deepseek-webchat'

		/** The tab kind. Unique per profile — the type registry keys on it. */
		const TAB_KIND = 'deepseek-webchat'

		/** The real web app. Never an API host, never an iframe. */
		const PAGE_URL = 'https://chat.deepseek.com/'

		/** DeepSeek's default agent, so a conversation URL is `/a/chat/s/<id>`. */
		const AGENT_ID = 'chat'

		/**
		 * The storage account asked of the shell. A constant on purpose: the shell
		 * caches one partition per workspace key for the whole app run, so one
		 * identity means one DeepSeek login shared by every DSH Session, with the
		 * per-Session split living in the conversation URL instead.
		 */
		const WORKSPACE = 'deepseek-webchat'

		/** How often the guest's storage is snapshotted, in ms. */
		const SAVE_INTERVAL_MS = 30000

		/** How often the guest's URL is re-read as a fallback, in ms. */
		const URL_POLL_MS = 2000

		/** Attribute marking this plugin's document-root guest container. */
		const OVERLAY_ATTR = 'data-dsh-deepseek-webchat-overlay'

		/** The host half's routes. */
		const ROUTES = {
			state: '/api/dsh-deepseek-webchat/state',
			messages: '/api/dsh-deepseek-webchat/messages',
			binding: '/api/dsh-deepseek-webchat/binding',
			sessionRestore: '/api/dsh-deepseek-webchat/session/restore',
			sessionSave: '/api/dsh-deepseek-webchat/session/save',
		}

		/** Locale-owned copy. */
		const zh = {
			'type.label': 'DeepSeek 网页版',
			'guide.title': 'DeepSeek 网页版',
			'guide.description': '在侧边栏打开 chat.deepseek.com',
			'action.send': '引用上下文',
			'action.back': '返回网页',
			'action.reload': '刷新',
			'action.rebind': '解除绑定',
			'action.refresh': '重新读取',
			'action.all': '全选',
			'action.none': '清除',
			'action.fill': '填入 DeepSeek 输入框',
			'action.copy': '复制',
			'picker.title': '选择要引用的消息',
			'picker.empty': '这个会话还没有可引用的消息。',
			'picker.loading': '正在读取会话…',
			'picker.selected': '已选 {count} 条',
			'picker.role.user': '用户',
			'picker.role.assistant': '助手',
			'picker.question': '要一起发送的问题或指令（可选）',
			'picker.questionPlaceholder': '例如：请基于以上内容，帮我补充一个更完整的方案。',
			'picker.preview': '将填入 DeepSeek 输入框的内容',
			'picker.hint': '填入后请自行在 DeepSeek 输入框里确认，并按 Enter 发送 —— 本插件不会自动发送。',
			'status.bound': '已绑定 DeepSeek 会话 {id}',
			'status.unbound': '未绑定 —— 在 DeepSeek 里发出第一条消息后自动绑定',
			'status.nobridge': '当前环境没有桌面浏览器通道，无法嵌入真实网页版。',
			'status.nobridgeHint': '请在 DSH 桌面版里使用；`dsh web` 之类的普通网页 profile 不带这个通道。',
			'status.failed': '嵌入失败：{error}',
			'status.filling': '正在填入…',
			'toast.filled': '已填入 DeepSeek 输入框（{count} 字），请手动按 Enter 发送。',
			'toast.nocomposer': '没找到 DeepSeek 输入框，请先在网页里打开一个对话。',
			'toast.copied': '已复制到剪贴板。',
			'toast.rebound': '已解除绑定，下次打开将新建对话。',
		}

		const en = {
			'type.label': 'DeepSeek Web',
			'guide.title': 'DeepSeek Web',
			'guide.description': 'Open chat.deepseek.com in the sidebar',
			'action.send': 'Quote context',
			'action.back': 'Back to page',
			'action.reload': 'Reload',
			'action.rebind': 'Unbind',
			'action.refresh': 'Read again',
			'action.all': 'Select all',
			'action.none': 'Clear',
			'action.fill': 'Fill DeepSeek composer',
			'action.copy': 'Copy',
			'picker.title': 'Choose messages to quote',
			'picker.empty': 'This session has no quotable messages yet.',
			'picker.loading': 'Reading the session…',
			'picker.selected': '{count} selected',
			'picker.role.user': 'User',
			'picker.role.assistant': 'Assistant',
			'picker.question': 'Question or instruction to send along (optional)',
			'picker.questionPlaceholder': 'e.g. Based on the above, help me draft a more complete plan.',
			'picker.preview': 'What will be filled into the DeepSeek composer',
			'picker.hint': 'After filling, review it in the DeepSeek composer and press Enter yourself — this plugin never sends.',
			'status.bound': 'Bound to DeepSeek conversation {id}',
			'status.unbound': 'Unbound — binds automatically after the first message is sent in DeepSeek',
			'status.nobridge': 'No desktop browser channel here, so the real web app cannot be embedded.',
			'status.nobridgeHint': 'Use the DSH desktop app; a plain `dsh web` profile does not carry this channel.',
			'status.failed': 'Embedding failed: {error}',
			'status.filling': 'Filling…',
			'toast.filled': 'Filled the DeepSeek composer ({count} chars) — press Enter yourself to send.',
			'toast.nocomposer': 'No DeepSeek composer found. Open a conversation in the page first.',
			'toast.copied': 'Copied to the clipboard.',
			'toast.rebound': 'Binding cleared; the next visit starts a new conversation.',
		}

		//#region urls

		/**
		 * The DeepSeek conversation URL for one conversation id.
		 * @param sessionId - DeepSeek conversation id.
		 * @returns the absolute URL.
		 */
		function conversationUrl(sessionId) {
			return PAGE_URL + 'a/' + AGENT_ID + '/s/' + encodeURIComponent(sessionId)
		}

		/**
		 * The DeepSeek conversation id inside a chat.deepseek.com URL.
		 * @param value - any URL string.
		 * @returns the conversation id, or undefined.
		 */
		function sessionIdOf(value) {
			if (typeof value !== 'string' || value === '') return undefined
			let url
			try {
				url = new URL(value)
			} catch (error) {
				return undefined
			}
			if (url.hostname !== 'chat.deepseek.com') return undefined
			const match = /^\/a\/[^/]+\/s\/([^/?#]+)\/?$/.exec(url.pathname)
			if (match === null) return undefined
			try {
				return decodeURIComponent(match[1])
			} catch (error) {
				return match[1]
			}
		}

		//#endregion

		//#region copy

		/**
		 * Interpolate `{name}` placeholders.
		 * @param template - the copy string.
		 * @param values - substitution values.
		 * @returns the filled string.
		 */
		function format(template, values) {
			return String(template).replace(/\{(\w+)\}/g, (whole, key) => (
				Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : whole
			))
		}

		/**
		 * The copy function to use when the framework's `t` seat is absent.
		 *
		 * A registration that declares `locale` receives a bound `t`, so this is
		 * only a backstop — but it resolves real copy rather than rendering raw
		 * keys like `action.send` if the seat ever fails to arrive.
		 * @returns a translate function over this plugin's dictionaries.
		 */
		function fallbackTranslate() {
			const language = typeof navigator === 'object' && typeof navigator.language === 'string'
				? navigator.language
				: 'en'
			const dictionary = language.toLowerCase().startsWith('zh') ? zh : en
			return (key, values) => {
				const template = dictionary[key] ?? en[key] ?? key
				return values === undefined ? template : format(template, values)
			}
		}

		//#endregion

		//#region guest plumbing

		/** The live guest, once one has been reserved. */
		let guest = null
		/** In-flight reservation, so concurrent callers share one attempt. */
		let acquiring = null
		/** Why the guest could not be created, or ''. */
		let failure = ''
		/** The DSH Session the guest is currently following. */
		let activeSessionId = undefined
		/** The last URL observed, so a binding is only taken from a settled URL. */
		let lastSeenUrl = ''
		/** The last URL this plugin asked the guest for, honoured at `dom-ready`. */
		let lastRequestedUrl = PAGE_URL
		/** True while the picker is open; the guest hides behind it. */
		let overlaySuppressed = false
		/** Subscribers told when the binding state changes. */
		const watchers = new Set()
		/** Session/conversation pairs already written, so polling does not rewrite. */
		const boundPairs = new Set()

		/** @returns a snapshot of the guest state for the UI. */
		function guestState() {
			return {
				ready: guest !== null,
				failure,
				hasBridge: hasBridge(),
			}
		}

		/** Notify every subscriber that the guest state changed. */
		function notify() {
			for (const watcher of [...watchers]) {
				try {
					watcher()
				} catch (error) {
					// A broken subscriber must not stop the others.
				}
			}
		}

		/** @returns the desktop browser bridge, or undefined off the desktop shell. */
		function bridge() {
			const carrier = globalThis.dshDesktop
			if (carrier === null || carrier === undefined) return undefined
			if (carrier.protocolVersion !== 1) return undefined
			const browser = carrier.browser
			if (browser === null || browser === undefined) return undefined
			if (typeof browser.acquire !== 'function') return undefined
			return browser
		}

		/** @returns whether the desktop browser channel is available. */
		function hasBridge() {
			return bridge() !== undefined
		}

		/**
		 * A plain Chrome user agent for the guest, derived from this renderer's
		 * own so the Chrome major version stays truthful.
		 *
		 * chat.deepseek.com greets an `electron` token in the user agent with an
		 * "使用环境异常 / Abnormal usage environment" dialog, and dismissing it is
		 * stored per guest partition — process-lifetime here, so it would come
		 * back on every restart. Its check is literally
		 * `navigator.userAgent.toLowerCase().includes("electron")`, so not
		 * advertising Electron is what keeps the page clean.
		 * @returns a Chrome user agent, or '' when this renderer reports none.
		 */
		function cleanUserAgent() {
			const ua = typeof navigator === 'object' && typeof navigator.userAgent === 'string'
				? navigator.userAgent
				: ''
			const platform = (ua.match(/^Mozilla\/5\.0 \([^)]*\)/) || [])[0]
			const chrome = (ua.match(/Chrome\/([0-9]+)/) || [])[1]
			if (platform === undefined || chrome === undefined) return ''
			return platform + ' AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + chrome + '.0.0.0 Safari/537.36'
		}

		/** Inject this plugin's stylesheet once. */
		function ensureStyle() {
			if (document.querySelector('style[' + OVERLAY_ATTR + '-style]') !== null) return
			const tag = document.createElement('style')
			tag.setAttribute(OVERLAY_ATTR + '-style', '')
			tag.textContent = [
				// The persistent guest, parked on the measured slot area.
				'[' + OVERLAY_ATTR + ']{position:fixed;display:none;z-index:40;overflow:hidden;background:#fff}',
				'[' + OVERLAY_ATTR + '] webview{-webkit-app-region:no-drag;border:0;display:flex;width:100%;height:100%}',
				// The panel itself.
				'.dswc-root{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;font-size:12px}',
				'.dswc-toolbar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsh-color-border-subtle,rgba(128,128,128,.25));flex:none}',
				'.dswc-status{font-size:11px;line-height:1;color:var(--dsh-color-text-secondary,#888)}',
				'.dswc-status[data-state="bound"]{color:#2ea043}',
				'.dswc-status[data-state="error"]{color:#d1242f}',
				'.dswc-gap{flex:1 1 auto}',
				'.dswc-button{font:inherit;font-size:11px;padding:3px 8px;border-radius:5px;border:1px solid var(--dsh-color-border-subtle,rgba(128,128,128,.35));background:transparent;color:inherit;cursor:pointer;white-space:nowrap}',
				'.dswc-button:hover:not(:disabled){background:var(--dsh-color-bg-hover,rgba(128,128,128,.12))}',
				'.dswc-button:disabled{opacity:.45;cursor:default}',
				'.dswc-primary{border-color:transparent;background:var(--dsh-color-accent,#4d6bfe);color:#fff}',
				'.dswc-primary:hover:not(:disabled){background:var(--dsh-color-accent,#4d6bfe);opacity:.88}',
				'.dswc-host{position:relative;flex:1 1 auto;min-height:0}',
				'.dswc-picker{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;gap:6px;padding:8px}',
				'.dswc-pickerHead{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:none}',
				'.dswc-pickerTitle{font-weight:600}',
				'.dswc-muted{color:var(--dsh-color-text-secondary,#888);font-size:11px}',
				'.dswc-list{flex:1 1 auto;min-height:60px;overflow:auto;border:1px solid var(--dsh-color-border-subtle,rgba(128,128,128,.25));border-radius:6px}',
				'.dswc-row{display:flex;gap:6px;padding:6px 8px;cursor:pointer;border-bottom:1px solid var(--dsh-color-border-subtle,rgba(128,128,128,.15))}',
				'.dswc-row:last-child{border-bottom:0}',
				'.dswc-row:hover{background:var(--dsh-color-bg-hover,rgba(128,128,128,.08))}',
				'.dswc-role{flex:none;width:30px;font-size:10px;color:var(--dsh-color-text-secondary,#888);padding-top:1px}',
				'.dswc-text{flex:1 1 auto;white-space:pre-wrap;word-break:break-word;max-height:96px;overflow:hidden}',
				'.dswc-compose{display:flex;flex-direction:column;gap:4px;flex:none}',
				'.dswc-label{font-size:11px;color:var(--dsh-color-text-secondary,#888)}',
				'.dswc-question,.dswc-preview{font:inherit;width:100%;box-sizing:border-box;padding:6px;border-radius:6px;border:1px solid var(--dsh-color-border-subtle,rgba(128,128,128,.3));background:var(--dsh-color-bg-input,transparent);color:inherit;resize:vertical}',
				'.dswc-preview{margin:0;max-height:150px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}',
				'.dswc-actions{display:flex;gap:6px}',
				'.dswc-notice{padding:12px;color:var(--dsh-color-text-secondary,#888);display:flex;flex-direction:column;gap:6px}',
				'.dswc-toast{flex:none;margin:0 8px 8px;padding:6px 8px;border-radius:6px;background:var(--dsh-color-bg-hover,rgba(128,128,128,.14));font-size:11px}',
				'.dswc-headerButton{display:inline-flex;align-items:center;justify-content:center;padding:4px;border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer}',
				'.dswc-headerButton:hover{background:var(--dsh-color-bg-hover,rgba(128,128,128,.12))}',
			].join('\n')
			document.head.appendChild(tag)
		}

		/** @returns the document-root container that keeps the guest alive. */
		function overlayContainer() {
			const existing = document.querySelector('[' + OVERLAY_ATTR + ']')
			if (existing !== null && existing !== undefined) return existing
			const box = document.createElement('div')
			box.setAttribute(OVERLAY_ATTR, '')
			document.body.appendChild(box)
			return box
		}

		/** Hide the guest without unmounting it. */
		function hideOverlay() {
			if (guest === null) return
			guest.container.style.display = 'none'
		}

		/**
		 * Park the guest on one measured rectangle.
		 * @param rect - the slot area, in viewport coordinates.
		 */
		function showOverlay(rect) {
			if (guest === null) return
			const style = guest.container.style
			style.left = rect.left + 'px'
			style.top = rect.top + 'px'
			style.width = rect.width + 'px'
			style.height = rect.height + 'px'
			style.display = 'block'
		}

		/**
		 * Suppress or release the guest while the picker is open.
		 * @param value - whether the picker is showing.
		 */
		function setOverlaySuppressed(value) {
			overlaySuppressed = value
			if (value) hideOverlay()
		}

		/** Ask the host to put the saved login back before the page is navigated. */
		async function restoreGuestSession() {
			try {
				const response = await fetch(ROUTES.sessionRestore, { method: 'POST' })
				const payload = await response.json()
				if (payload === null || typeof payload !== 'object') return null
				const storage = Array.isArray(payload.storage) ? payload.storage : []
				const cookie = typeof payload.cookie === 'string' ? payload.cookie : ''
				if (storage.length === 0 && cookie === '') return null
				return { storage, cookie }
			} catch (error) {
				return null
			}
		}

		/**
		 * Read the guest's own storage and cookie string.
		 *
		 * That string cannot carry HttpOnly cookies, but DeepSeek keeps its
		 * credential in `localStorage.userToken` and sends it as a bearer token,
		 * so replaying site storage is what actually restores a login.
		 * @param element - the live webview.
		 * @returns the guest state as JSON text.
		 */
		function readGuestState(element) {
			return element.executeJavaScript(
				'JSON.stringify({ storage: Object.keys(localStorage).map(function (key) { return [key, localStorage.getItem(key)] }), cookie: document.cookie })',
			)
		}

		/**
		 * Write a guest state back into the page.
		 * @param element - the live webview.
		 * @param state - `{ storage, cookie }`.
		 */
		function writeGuestState(element, state) {
			return element.executeJavaScript(
				'(function () { var state = ' + JSON.stringify(state) + ';'
				+ ' var storage = Array.isArray(state.storage) ? state.storage : [];'
				+ ' for (var i = 0; i < storage.length; i++) { try { localStorage.setItem(storage[i][0], storage[i][1]) } catch (error) {} }'
				+ " if (typeof state.cookie === 'string' && state.cookie !== '') {"
				+ " var parts = state.cookie.split('; ');"
				+ ' for (var j = 0; j < parts.length; j++) {'
				+ ' var pair = parts[j];'
				+ " if (pair.indexOf('=') === -1) continue;"
				+ " try { document.cookie = pair + '; path=/' } catch (error) {}"
				+ ' } }'
				+ ' return true })()',
			)
		}

		/**
		 * Whether a guest element is currently on the DeepSeek origin.
		 *
		 * This guard is what protects the saved login. The guest starts on
		 * `about:blank#<lease>` and reaches DeepSeek a navigation later, so an
		 * early `did-finish-load` can fire while the page is still on the opaque
		 * origin — where `localStorage` throws and `document.cookie` is empty.
		 * Reading state there would return nothing, and saving that nothing would
		 * overwrite the snapshot the next launch needs. So both directions of the
		 * snapshot are confined to the real origin.
		 * @param element - the live webview.
		 * @returns true when its URL is on chat.deepseek.com.
		 */
		function onDeepSeekOrigin(element) {
			try {
				return new URL(element.getURL()).hostname === 'chat.deepseek.com'
			} catch (error) {
				return false
			}
		}

		/**
		 * Ask the host to refresh the stored login snapshot.
		 *
		 * The partition is deliberately not sent: it is a fresh
		 * `dsh-sidebar-browser-<uuid>` every run, so it identifies nothing across
		 * restarts and the snapshot is keyed to this plugin instead.
		 * @param withState - whether to include what only the guest can read.
		 */
		async function saveGuestSession(withState) {
			if (guest === null) return
			// Never let an off-origin read blank the snapshot.
			if (!onDeepSeekOrigin(guest.element)) return
			let state = null
			if (withState) {
				try {
					state = JSON.parse(await readGuestState(guest.element))
				} catch (error) {
					// Not ready: keep whatever the host already has.
					return
				}
			}
			try {
				await fetch(ROUTES.sessionSave, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						storage: Array.isArray(state?.storage) ? state.storage : [],
						cookie: typeof state?.cookie === 'string' ? state.cookie : '',
					}),
				})
			} catch (error) {
				// Best effort: a snapshot that fails costs a login, not the page.
			}
		}

		/**
		 * Record one DSH Session → DeepSeek conversation binding.
		 *
		 * Remembered once taken, because `observeUrl` polls: without this the same
		 * pair would be re-POSTed every few seconds, and each write would notify
		 * the panel and re-render it forever.
		 * @param dshSessionId - DSH Session id.
		 * @param deepseekSessionId - DeepSeek conversation id.
		 */
		async function bind(dshSessionId, deepseekSessionId) {
			if (typeof dshSessionId !== 'string' || dshSessionId === '') return
			const pair = dshSessionId + '\u0000' + deepseekSessionId
			if (boundPairs.has(pair)) return
			boundPairs.add(pair)
			try {
				await fetch(ROUTES.binding, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ dshSessionId, deepseekSessionId }),
				})
				notify()
			} catch (error) {
				// The next observation retries, so drop the claim.
				boundPairs.delete(pair)
			}
		}

		/**
		 * Forget the write cache for one DSH Session.
		 * @param dshSessionId - DSH Session id.
		 */
		function forgetBoundPairs(dshSessionId) {
			const prefix = dshSessionId + '\u0000'
			for (const pair of [...boundPairs]) {
				if (pair.startsWith(prefix)) boundPairs.delete(pair)
			}
		}

		/**
		 * @param dshSessionId - DSH Session id.
		 * @returns the bound DeepSeek conversation id, or null.
		 */
		async function readBinding(dshSessionId) {
			if (typeof dshSessionId !== 'string' || dshSessionId === '') return null
			try {
				const response = await fetch(
					ROUTES.binding + '?sessionId=' + encodeURIComponent(dshSessionId),
				)
				const payload = await response.json()
				const value = payload?.deepseekSessionId
				return typeof value === 'string' && value !== '' ? value : null
			} catch (error) {
				return null
			}
		}

		/**
		 * Observe the guest's URL, requiring it to have settled before trusting it.
		 *
		 * DeepSeek creates a conversation only when the first message is sent, so
		 * the id appears by navigation rather than by any API this plugin can
		 * call. Requiring two identical readings keeps a transient URL during a
		 * session switch from being bound to the wrong DSH Session.
		 */
		function observeUrl() {
			if (guest === null || activeSessionId === undefined) return
			let url
			try {
				url = guest.element.getURL()
			} catch (error) {
				return
			}
			if (url !== lastSeenUrl) {
				lastSeenUrl = url
				return
			}
			const deepseekSessionId = sessionIdOf(url)
			if (deepseekSessionId === undefined) return
			void bind(activeSessionId, deepseekSessionId)
		}

		/**
		 * Point the guest at the conversation this DSH Session owns.
		 *
		 * A bound Session opens its conversation directly. An unbound one is left
		 * alone when the guest already sits in an unbound conversation — that
		 * conversation was started for this very Session and is about to be bound
		 * — and is otherwise sent back to the root so the user starts fresh.
		 * @param dshSessionId - the DSH Session the guest should follow.
		 */
		async function focusSession(dshSessionId) {
			activeSessionId = dshSessionId
			lastSeenUrl = ''
			if (guest === null) return
			let current
			try {
				current = guest.element.getURL()
			} catch (error) {
				current = ''
			}
			const bound = await readBinding(dshSessionId)
			if (bound !== null) {
				if (sessionIdOf(current) === bound) return
				navigate(conversationUrl(bound))
				return
			}
			const currentId = sessionIdOf(current)
			if (currentId === undefined) return
			// The guest is inside some conversation. Only send it home when that
			// conversation belongs to a different DSH Session.
			const owner = await ownerOf(currentId)
			if (owner !== null && owner !== dshSessionId) navigate(PAGE_URL)
		}

		/**
		 * @param deepseekSessionId - DeepSeek conversation id.
		 * @returns the DSH Session that owns it, or null when unbound.
		 */
		async function ownerOf(deepseekSessionId) {
			try {
				const response = await fetch(
					ROUTES.binding + '?deepseekSessionId=' + encodeURIComponent(deepseekSessionId),
				)
				const payload = await response.json()
				const value = payload?.dshSessionId
				return typeof value === 'string' && value !== '' ? value : null
			} catch (error) {
				return null
			}
		}

		/**
		 * Navigate the guest, tolerating a navigation already in flight.
		 * @param url - absolute URL.
		 */
		function navigate(url) {
			if (guest === null) return
			lastSeenUrl = ''
			lastRequestedUrl = url
			try {
				const pending = guest.element.loadURL(url)
				if (pending !== undefined && typeof pending.catch === 'function') {
					pending.catch(() => undefined)
				}
			} catch (error) {
				// A navigation superseded by another one is not an error worth showing.
			}
		}

		/**
		 * Reserve a guest and attach its webview, once per app run.
		 * @returns a promise resolving once the attempt settled.
		 */
		function ensureGuest() {
			if (guest !== null) return Promise.resolve()
			const browser = bridge()
			if (browser === undefined) {
				failure = ''
				notify()
				return Promise.resolve()
			}
			if (acquiring !== null) return acquiring
			acquiring = (async () => {
				try {
					const reservation = await browser.acquire(WORKSPACE)
					if (reservation === null || typeof reservation !== 'object'
						|| typeof reservation.lease !== 'string'
						|| typeof reservation.partition !== 'string') {
						throw new Error('the desktop browser bridge returned no reservation')
					}
					const restored = await restoreGuestSession()
					const element = document.createElement('webview')
					element.setAttribute('name', reservation.lease)
					element.setAttribute('partition', reservation.partition)
					element.setAttribute('src', 'about:blank#' + reservation.lease)
					const userAgent = cleanUserAgent()
					if (userAgent !== '') element.setAttribute('useragent', userAgent)
					const record = {
						lease: reservation.lease,
						partition: reservation.partition,
						element,
						container: overlayContainer(),
						storageState: restored === null ? 'none' : 'pending',
						timer: 0,
						poller: 0,
					}
					// The guest exists by `dom-ready` and nothing has been navigated
					// yet, so this is the user agent the page actually loads with.
					element.addEventListener('dom-ready', () => {
						if (userAgent !== '') {
							try {
								element.setUserAgent(userAgent)
							} catch (error) {
								// The attribute above already covers most of it.
							}
						}
						navigate(lastRequestedUrl)
					}, { once: true })
					// Storage and cookies can only be written while the page is on
					// its own origin, so both are restored after the first load of
					// the real site and the page is then asked to load once more —
					// this time already signed in. The origin check matters: the
					// guest's first document is `about:blank#<lease>`, where writing
					// storage throws, and treating that as the restore would burn
					// the one attempt. Until this settles, snapshots are skipped:
					// the freshly loaded page still has empty storage, and saving
					// that would erase the very snapshot being restored.
					element.addEventListener('did-finish-load', () => {
						if (record.storageState !== 'pending') return
						if (!onDeepSeekOrigin(element)) return
						record.storageState = 'restoring'
						Promise.resolve(writeGuestState(element, restored))
							.then(() => {
								record.storageState = 'done'
								element.reload()
							})
							.catch(() => {
								record.storageState = 'done'
							})
					})
					element.addEventListener('did-finish-load', () => {
						if (record.storageState === 'pending' || record.storageState === 'restoring') return
						void saveGuestSession(true)
					})
					for (const event of ['did-navigate', 'did-navigate-in-page', 'did-finish-load']) {
						element.addEventListener(event, () => {
							lastSeenUrl = ''
							observeUrl()
						})
					}
					record.container.appendChild(element)
					guest = record
					record.timer = setInterval(() => {
						void saveGuestSession(true)
					}, SAVE_INTERVAL_MS)
					record.poller = setInterval(observeUrl, URL_POLL_MS)
					failure = ''
				} catch (error) {
					failure = error instanceof Error ? error.message : String(error)
				} finally {
					acquiring = null
					notify()
				}
			})()
			return acquiring
		}

		/** Release the guest and detach everything it owns. */
		function disposeGuest() {
			if (guest === null) return
			const record = guest
			guest = null
			clearInterval(record.timer)
			clearInterval(record.poller)
			try {
				record.element.remove()
			} catch (error) {
				// Already gone.
			}
			try {
				record.container.remove()
			} catch (error) {
				// Already gone.
			}
			const browser = bridge()
			if (browser !== undefined && typeof browser.release === 'function') {
				try {
					browser.release(record.lease)
				} catch (error) {
					// The shell owns the lease's real lifetime.
				}
			}
			notify()
		}

		//#endregion

		//#region composing

		/**
		 * One message as a blockquote block, so every line stays quoted.
		 * @param label - the role label.
		 * @param text - the message text.
		 * @returns the blockquote, or '' for an empty message.
		 */
		function quoteBlock(label, text) {
			const body = String(text).trim()
			if (body === '') return ''
			const lines = body.split(/\r?\n/)
			return ['> 【' + label + '】' + lines[0]]
				.concat(lines.slice(1).map((line) => '> ' + line))
				.join('\n')
		}

		/**
		 * Compose the blockquote plus the user's own question.
		 * @param rows - the selected messages, in log order.
		 * @param labels - role labels.
		 * @param question - the user's question or instruction.
		 * @returns the text to fill into the DeepSeek composer.
		 */
		function compose(rows, labels, question) {
			const blocks = []
			for (const row of rows) {
				const label = row.role === 'user' ? labels.user : labels.assistant
				const block = quoteBlock(label, row.text)
				if (block !== '') blocks.push(block)
			}
			const quoted = blocks.join('\n\n')
			const asked = String(question ?? '').trim()
			if (quoted === '') return asked
			if (asked === '') return quoted
			return quoted + '\n\n---\n\n' + asked
		}

		/**
		 * The script that fills the DeepSeek composer.
		 *
		 * The composer is a React-controlled `<textarea class="ds-textarea__textarea">`
		 * (the class is built as `"ds" + "-textarea__textarea"` in DeepSeek's own
		 * bundle). Writing `.value` directly is ignored by React, so the native
		 * value setter is used and an `input` event is dispatched, which is what
		 * makes React commit the change. Nothing is submitted.
		 * @param text - the text to place in the composer.
		 * @returns a self-contained script expression.
		 */
		function fillScript(text) {
			return '(function () {'
				+ ' try {'
				+ ' var text = ' + JSON.stringify(text) + ';'
				+ ' var el = document.querySelector("textarea.ds-textarea__textarea")'
				+ ' || document.querySelector("textarea[placeholder]")'
				+ ' || document.querySelector("textarea");'
				+ ' if (!el) return { ok: false, error: "no-composer" };'
				+ ' el.focus();'
				+ ' var proto = Object.getPrototypeOf(el);'
				+ ' var desc = Object.getOwnPropertyDescriptor(proto, "value")'
				+ ' || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");'
				+ ' if (desc && desc.set) desc.set.call(el, text); else el.value = text;'
				+ ' el.dispatchEvent(new Event("input", { bubbles: true }));'
				+ ' el.dispatchEvent(new Event("change", { bubbles: true }));'
				+ ' el.selectionStart = el.value.length;'
				+ ' el.selectionEnd = el.value.length;'
				+ ' return { ok: true, length: el.value.length };'
				+ ' } catch (error) {'
				+ ' return { ok: false, error: String(error && error.message || error) };'
				+ ' }'
				+ ' })()'
		}

		/**
		 * Fill the guest's composer.
		 * @param text - the text to place there.
		 * @returns a result describing what happened.
		 */
		async function fillComposer(text) {
			if (guest === null) return { ok: false, error: 'no-guest' }
			try {
				const result = await guest.element.executeJavaScript(fillScript(text))
				if (result === null || typeof result !== 'object') return { ok: false, error: 'no-result' }
				return result
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) }
			}
		}

		//#endregion

		//#region ui

		/**
		 * The guide door's artwork. The shell sizes a guide icon itself, so the
		 * glyph reads the `size`/`className` it is handed.
		 * @param props - `{ size, className }` from the guide entry.
		 */
		function GuideArtwork(props) {
			const size = props?.size ?? 24
			return h('svg', {
				width: size, height: size, viewBox: '0 0 24 24',
				className: props?.className,
				fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
				strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
			}, [
				h('path', { key: 'b', d: 'M3 5h18v12H11l-4 3.5V17H3z' }),
				h('path', { key: 'd', d: 'M8 11h8' }),
			])
		}

		/**
		 * The tab body: a toolbar, and either the picker or the measured guest area.
		 * @param props - standard slot props plus the injected session id.
		 */
		function DeepSeekBody(props) {
			const useTabInfo = props.useTabInfo
			const tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : undefined
			const sessionId = props.sessionId ?? tabInfo?.tab?.sessionId
			const t = props.t ?? fallbackTranslate()

			const hostRef = React.useRef(null)
			const [version, setVersion] = React.useState(0)
			const [pickerOpen, setPickerOpen] = React.useState(false)
			const [bound, setBound] = React.useState(null)
			const [messages, setMessages] = React.useState(null)
			const [loadError, setLoadError] = React.useState('')
			const [selected, setSelected] = React.useState(() => new Set())
			const [question, setQuestion] = React.useState('')
			const [busy, setBusy] = React.useState(false)
			const [toast, setToast] = React.useState('')

			// React to the guest coming up, failing, or binding.
			React.useEffect(() => {
				const watcher = () => setVersion((value) => value + 1)
				watchers.add(watcher)
				return () => {
					watchers.delete(watcher)
				}
			}, [])

			// Bring the guest up once the shell has a bridge for it.
			React.useEffect(() => {
				if (!hasBridge()) return
				void ensureGuest()
			}, [])

			// Follow the DSH Session this pane belongs to.
			React.useEffect(() => {
				if (sessionId === undefined) return
				let cancelled = false
				void (async () => {
					await ensureGuest()
					if (cancelled) return
					await focusSession(sessionId)
					if (cancelled) return
					setBound(await readBinding(sessionId))
				})()
				return () => {
					cancelled = true
				}
			}, [sessionId, version])

			// Park the guest on the measured area, and keep it parked.
			React.useEffect(() => {
				const host = hostRef.current
				if (host === null) return undefined
				const update = () => {
					if (overlaySuppressed || guest === null) {
						hideOverlay()
						return
					}
					const rect = host.getBoundingClientRect()
					// `getClientRects()` is empty when the host or any ancestor is
					// `display: none`, which is how an unselected pane hides — so it
					// is the right test, and `offsetParent` is not (it is null for a
					// fixed-position ancestor even when the element is plainly
					// visible). The size guard rejects a pane mid-layout.
					const visible = host.getClientRects().length > 0
						&& rect.width > 2
						&& rect.height > 2
					if (!visible) {
						hideOverlay()
						return
					}
					showOverlay(rect)
				}
				update()
				const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
				if (observer !== null) observer.observe(host)
				window.addEventListener('resize', update)
				const timer = setInterval(update, 250)
				return () => {
					if (observer !== null) observer.disconnect()
					window.removeEventListener('resize', update)
					clearInterval(timer)
					hideOverlay()
				}
			}, [pickerOpen, version])

			// Hide the guest behind the picker.
			React.useEffect(() => {
				setOverlaySuppressed(pickerOpen)
			}, [pickerOpen])

			// Read the session's messages when the picker opens.
			React.useEffect(() => {
				if (!pickerOpen || sessionId === undefined) return undefined
				let cancelled = false
				setMessages(null)
				setLoadError('')
				void (async () => {
					try {
						const response = await fetch(
							ROUTES.messages + '?sessionId=' + encodeURIComponent(sessionId),
						)
						const payload = await response.json()
						if (cancelled) return
						if (payload?.ok !== true) {
							setLoadError(String(payload?.error ?? 'unknown'))
							setMessages([])
							return
						}
						setMessages(Array.isArray(payload.messages) ? payload.messages : [])
					} catch (error) {
						if (cancelled) return
						setLoadError(error instanceof Error ? error.message : String(error))
						setMessages([])
					}
				})()
				return () => {
					cancelled = true
				}
			}, [pickerOpen, sessionId, version])

			const labels = React.useMemo(() => ({
				user: t('picker.role.user'),
				assistant: t('picker.role.assistant'),
			}), [t])

			const chosen = React.useMemo(() => {
				if (messages === null) return []
				return messages.filter((row) => selected.has(row.seq))
			}, [messages, selected])

			const preview = React.useMemo(
				() => compose(chosen, labels, question),
				[chosen, labels, question],
			)

			const toggle = React.useCallback((seq) => {
				setSelected((current) => {
					const next = new Set(current)
					if (next.has(seq)) next.delete(seq)
					else next.add(seq)
					return next
				})
			}, [])

			const fill = React.useCallback(async () => {
				if (preview.trim() === '') return
				setBusy(true)
				setToast('')
				try {
					setPickerOpen(false)
					// Let the guest become visible again before scripting it.
					await new Promise((resolve) => setTimeout(resolve, 120))
					const result = await fillComposer(preview)
					if (result.ok === true) {
						setToast(format(t('toast.filled'), { count: result.length ?? preview.length }))
					} else if (result.error === 'no-composer') {
						setToast(t('toast.nocomposer'))
					} else {
						setToast(t('status.failed', { error: String(result.error) }))
					}
				} finally {
					setBusy(false)
				}
			}, [preview, t])

			const copy = React.useCallback(async () => {
				try {
					await navigator.clipboard.writeText(preview)
					setToast(t('toast.copied'))
				} catch (error) {
					setToast(String(error))
				}
			}, [preview, t])

			const unbind = React.useCallback(async () => {
				if (sessionId === undefined) return
				await fetch(ROUTES.binding, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ dshSessionId: sessionId, forget: true }),
				})
				// Drop the write cache too, or a later visit to the same
				// conversation would be silently skipped as "already bound".
				forgetBoundPairs(sessionId)
				setBound(null)
				setToast(t('toast.rebound'))
				navigate(PAGE_URL)
			}, [sessionId, t])

			const state = guestState()
			const statusText = state.failure !== ''
				? format(t('status.failed'), { error: state.failure })
				: (bound !== null ? format(t('status.bound'), { id: bound }) : t('status.unbound'))

			// A glyph, not a sentence: the full status is the tooltip, because a
			// failure message is far too long for a toolbar.
			const statusGlyph = state.failure !== '' ? '⚠' : (bound !== null ? '●' : '○')

			const toolbar = h('div', { className: 'dswc-toolbar' }, [
				h('span', {
					key: 'status',
					className: 'dswc-status',
					title: statusText,
					role: 'img',
					'aria-label': statusText,
					'data-state': state.failure !== '' ? 'error' : (bound !== null ? 'bound' : 'unbound'),
				}, statusGlyph),
				h('span', { key: 'gap', className: 'dswc-gap' }),
				h('button', {
					key: 'send',
					type: 'button',
					className: 'dswc-button',
					onClick: () => setPickerOpen((open) => !open),
				}, pickerOpen ? t('action.back') : t('action.send')),
				h('button', {
					key: 'reload',
					type: 'button',
					className: 'dswc-button',
					onClick: () => {
						if (guest !== null) {
							try {
								guest.element.reload()
							} catch (error) {
								// Nothing to reload.
							}
						}
					},
				}, t('action.reload')),
				h('button', {
					key: 'unbind',
					type: 'button',
					className: 'dswc-button',
					disabled: bound === null,
					onClick: () => void unbind(),
				}, t('action.rebind')),
			])

			const toastRow = toast === ''
				? null
				: h('div', { className: 'dswc-toast' }, toast)

			if (!state.hasBridge) {
				return h('div', { className: 'dswc-root' }, [
					toolbar,
					h('div', { key: 'notice', className: 'dswc-notice' }, [
						h('p', { key: 'a' }, t('status.nobridge')),
						h('p', { key: 'b', className: 'dswc-muted' }, t('status.nobridgeHint')),
					]),
				])
			}

			if (!pickerOpen) {
				return h('div', { className: 'dswc-root' }, [
					toolbar,
					h('div', { key: 'host', className: 'dswc-host', ref: hostRef }),
					toastRow,
				])
			}

			const list = messages === null
				? h('div', { className: 'dswc-notice' }, t('picker.loading'))
				: messages.length === 0
					? h('div', { className: 'dswc-notice' }, [
						h('p', { key: 'a' }, t('picker.empty')),
						loadError === '' ? null : h('p', { key: 'b', className: 'dswc-muted' }, loadError),
					])
					: h('div', { className: 'dswc-list' }, messages.map((row) => h('label', {
						key: row.seq,
						className: 'dswc-row',
						'data-role': row.role,
					}, [
						h('input', {
							key: 'box',
							type: 'checkbox',
							checked: selected.has(row.seq),
							onChange: () => toggle(row.seq),
						}),
						h('span', { key: 'role', className: 'dswc-role' },
							row.role === 'user' ? labels.user : labels.assistant),
						h('span', { key: 'text', className: 'dswc-text' }, row.text),
					])))

			return h('div', { className: 'dswc-root' }, [
				toolbar,
				h('div', { key: 'picker', className: 'dswc-picker' }, [
					h('div', { key: 'head', className: 'dswc-pickerHead' }, [
						h('span', { key: 'title', className: 'dswc-pickerTitle' }, t('picker.title')),
						h('span', { key: 'count', className: 'dswc-muted' },
							format(t('picker.selected'), { count: chosen.length })),
						h('span', { key: 'gap', className: 'dswc-gap' }),
						h('button', {
							key: 'all',
							type: 'button',
							className: 'dswc-button',
							onClick: () => setSelected(new Set((messages ?? []).map((row) => row.seq))),
						}, t('action.all')),
						h('button', {
							key: 'none',
							type: 'button',
							className: 'dswc-button',
							onClick: () => setSelected(new Set()),
						}, t('action.none')),
						h('button', {
							key: 'refresh',
							type: 'button',
							className: 'dswc-button',
							onClick: () => setVersion((value) => value + 1),
						}, t('action.refresh')),
					]),
					list,
					h('div', { key: 'compose', className: 'dswc-compose' }, [
						h('label', { key: 'qlabel', className: 'dswc-label' }, t('picker.question')),
						h('textarea', {
							key: 'question',
							className: 'dswc-question',
							rows: 3,
							value: question,
							placeholder: t('picker.questionPlaceholder'),
							onChange: (event) => setQuestion(event.target.value),
						}),
						h('label', { key: 'plabel', className: 'dswc-label' }, t('picker.preview')),
						h('pre', { key: 'preview', className: 'dswc-preview' }, preview),
						h('p', { key: 'hint', className: 'dswc-muted' }, t('picker.hint')),
						h('div', { key: 'actions', className: 'dswc-actions' }, [
							h('button', {
								key: 'fill',
								type: 'button',
								className: 'dswc-button dswc-primary',
								disabled: busy || preview.trim() === '',
								onClick: () => void fill(),
							}, busy ? t('status.filling') : t('action.fill')),
							h('button', {
								key: 'copy',
								type: 'button',
								className: 'dswc-button',
								disabled: preview.trim() === '',
								onClick: () => void copy(),
							}, t('action.copy')),
						]),
					]),
				]),
				toastRow,
			])
		}

		//#endregion

		/**
		 * A one-click door in the conversation header, so the tab does not have to
		 * be reached through the column's guide.
		 * @param props - standard props plus the injected `open`.
		 */
		function HeaderButton(props) {
			const t = props.t ?? fallbackTranslate()
			const label = t('action.send')
			return h('button', {
				type: 'button',
				className: 'dswc-headerButton',
				title: label,
				'aria-label': label,
				onClick: () => props.open(),
			}, h('svg', {
				width: 15, height: 15, viewBox: '0 0 24 24',
				fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
				strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
			}, [
				h('path', { key: 'b', d: 'M3 5h18v12H11l-4 3.5V17H3z' }),
				h('path', { key: 'd', d: 'M8 11h8' }),
			]))
		}

		/** Register the tab type, its guide door, and its body. */
		function apply(ctx) {
			ensureStyle()
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'deepseek-webchat: copy')
			const t = ctx.locale.bind(NS)
			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: TAB_ID,
				kind: TAB_KIND,
				title: () => t('type.label'),
				// A `<webview>` dies when it leaves the document, so the body must
				// outlive a tab switch for the page (and a half-typed question) to
				// survive one.
				keepMounted: true,
				guide: [{
					id: 'open',
					order: 40,
					title: () => t('guide.title'),
					description: () => t('guide.description'),
					icon: GuideArtwork,
				}],
			}), 'deepseek-webchat: tab type')
			ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
				name: 'sidebar.right.pane.tab',
				key: TAB_ID,
				locale: NS,
				inject: (sessionId) => ({ sessionId }),
			}, DeepSeekBody)), 'deepseek-webchat: body')
			ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
				name: 'conversation.session.header.utilities',
				id: 'deepseek-webchat',
				order: 20,
				locale: NS,
				inject: (sessionId) => ({
					open: () => ctx.sidebarRight.openTabIn(sessionId, TAB_KIND, { revealIfOpened: true }),
				}),
			}, HeaderButton)), 'deepseek-webchat: header door')
			ctx.effect(() => () => {
				disposeGuest()
			}, 'deepseek-webchat: guest lifetime')
		}

		const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
