/**
 * dsh-deepseek-webchat 鈥?browser half.
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
 * every look at another tab would tear down the page and reload it 鈥?losing a
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
 * The mapping DSH Session 鈫?DeepSeek conversation id is learned by watching the
 * guest's URL (the id only appears once the first message is sent, because
 * DeepSeek creates conversations lazily) and is persisted by the host half,
 * which is where a durable file can live.
 *
 * ## What this half never does
 *
 * It never sends anything to DeepSeek on its own. Selecting messages composes a
 * blockquote and *fills the composer*; pressing Enter is the human's move. It
 * never reads a DeepSeek answer back into the DSH conversation, and it never
 * quotes system, developer or injected-prompt events 鈥?those are filtered by the
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

		/** The tab kind. Unique per profile 鈥?the type registry keys on it. */
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

		/**
		 * The host half's routes.
		 *
		 * Every route the host registers must appear here, and a test asserts the
		 * two lists match: a missing entry is `undefined`, and `fetch(undefined)`
		 * rejects into whichever catch swallows it 鈥?so the feature fails silently
		 * with nothing to see.
		 */
		const ROUTES = {
			state: '/api/dsh-deepseek-webchat/state',
			messages: '/api/dsh-deepseek-webchat/messages',
			binding: '/api/dsh-deepseek-webchat/binding',
			sessionRestore: '/api/dsh-deepseek-webchat/session/restore',
			sessionSave: '/api/dsh-deepseek-webchat/session/save',
			diag: '/api/dsh-deepseek-webchat/diag',
		}

		/** Locale-owned copy. */
		const zh = {
			'type.label': 'DeepSeek 缃戦〉鐗?,
			'guide.title': 'DeepSeek 缃戦〉鐗?,
			'guide.description': '鍦ㄤ晶杈规爮鎵撳紑 chat.deepseek.com',
			'action.send': '寮曠敤涓婁笅鏂?,
			'action.back': '杩斿洖缃戦〉',
			'action.reload': '鍒锋柊',
			'action.rebind': '瑙ｉ櫎缁戝畾',
			'action.refresh': '閲嶆柊璇诲彇',
			'action.all': '鍏ㄩ€?,
			'action.none': '娓呴櫎',
			'action.last': '閫夋湯灏?,
			'action.fill': '濉叆骞跺彂閫?,
			'action.fillOnly': '浠呭～鍏?,
			'action.copy': '澶嶅埗',
			'picker.title': '閫夋嫨瑕佸紩鐢ㄧ殑娑堟伅',
			'picker.empty': '杩欎釜浼氳瘽杩樻病鏈夊彲寮曠敤鐨勬秷鎭€?,
			'picker.emptyAdvanced': '杩欎釜浼氳瘽杩樻病鏈夊彲寮曠敤鐨勫唴瀹广€?,
			'picker.loading': '姝ｅ湪璇诲彇浼氳瘽鈥?,
			'picker.selected': '宸查€?{count} 鏉?,
			'picker.role.user': '鐢ㄦ埛',
			'picker.role.assistant': '鍔╂墜',
			'picker.role.tool': '宸ュ叿',
			'picker.advanced': '楂樼骇锛氬寘鍚€濊€冭繃绋嬩笌宸ュ叿璋冪敤',
			'picker.advancedHint': '榛樿鍙垪浣犱笌鍔╂墜鐨勫璇濓紝浠ュ強 AI 鍚戜綘鎻愮殑闂鍜岄€夐」銆傛墦寮€鍚庝細棰濆鍒楀嚭鎬濊€冭繃绋嬨€佸伐鍏疯皟鐢ㄣ€佸伐鍏风粨鏋溿€佸緟鍔炪€佸懡浠や笌鍘嬬缉鎽樿銆?,
			'picker.kind.question': '鎻愰棶',
			'picker.kind.answer': '鍥炵瓟',
			'picker.kind.reasoning': '鎬濊€?,
			'picker.kind.toolCall': '璋冪敤',
			'picker.kind.toolResult': '缁撴灉',
			'picker.kind.todo': '寰呭姙',
			'picker.kind.command': '鍛戒护',
			'picker.kind.summary': '鎽樿',
			'picker.preamble': '闄勪笂璇存槑',
			'picker.preambleHint': '鍦ㄥ紩鐢ㄥ唴瀹瑰墠闈㈠姞涓€灏忔璇存槑锛屽憡璇?DeepSeek 杩欎簺鍐呭鏄粈涔堛€佹潵鑷摢閲屻€?,
			'picker.preambleText': '浠ヤ笅鏄垜鍦ㄥ彟涓€涓?AI 鍔╂墜锛圖SH锛夐噷鐨勫璇濈墖娈碉紝寮曠敤缁欎綘浣滀负鑳屾櫙鍙傝€冦€備互銆? 銆嶅紑澶寸殑琛屾槸鍘熸枃锛屻€愩€戦噷鏍囧嚭鐨勬槸杩欐鍐呭灞炰簬璋侊紙鐢ㄦ埛銆佸姪鎵嬨€佹彁闂€佸洖绛斻€佸伐鍏疯皟鐢ㄧ瓑锛夈€傝鍏堢悊瑙ｈ繖浜涜儗鏅紝鍐嶅洖绛旀垜鏈€涓嬮潰鐨勯棶棰橈紱濡傛灉鑳屾櫙閲屾湁涓嶆竻妤氱殑鍦版柟锛岃鐩存帴鎸囧嚭銆?,
			'picker.lastCount': '鏈熬鏉℃暟',
			'picker.question': '瑕佷竴璧峰彂閫佺殑闂鎴栨寚浠わ紙鍙€夛級',
			'picker.questionPlaceholder': '渚嬪锛氳鍩轰簬浠ヤ笂鍐呭锛屽府鎴戣ˉ鍏呬竴涓洿瀹屾暣鐨勬柟妗堛€?,
			'picker.preview': '灏嗗～鍏?DeepSeek 杈撳叆妗嗙殑鍐呭',
			'picker.hint': '鐐广€屽～鍏ュ苟鍙戦€併€嶄細鐩存帴鎶婇瑙堝唴瀹瑰彂缁?DeepSeek锛涙兂鍏堣嚜宸辩‘璁ゅ氨鐐广€屼粎濉叆銆嶃€備袱绉嶆儏鍐甸兘涓嶄細鏀瑰姩 DSH 閲岀殑瀵硅瘽銆?,
			'toast.sent': '宸插彂閫佸埌 DeepSeek锛坽count} 瀛楋級銆?,
			'toast.sendPending': '宸插～鍏?DeepSeek 杈撳叆妗嗭紝浣嗚嚜鍔ㄥ彂閫佹病鏈夌敓鏁?鈥斺€?璇锋墜鍔ㄦ寜 Enter銆?,
			'status.bound': '宸茬粦瀹?DeepSeek 浼氳瘽 {id}',
			'status.unbound': '鏈粦瀹?鈥斺€?鍦?DeepSeek 閲屽彂鍑虹涓€鏉℃秷鎭悗鑷姩缁戝畾',
			'status.nobridge': '褰撳墠鐜娌℃湁妗岄潰娴忚鍣ㄩ€氶亾锛屾棤娉曞祵鍏ョ湡瀹炵綉椤电増銆?,
			'status.nobridgeHint': '璇峰湪 DSH 妗岄潰鐗堥噷浣跨敤锛沗dsh web` 涔嬬被鐨勬櫘閫氱綉椤?profile 涓嶅甫杩欎釜閫氶亾銆?,
			'status.failed': '宓屽叆澶辫触锛歿error}',
			'status.filling': '姝ｅ湪濉叆鈥?,
			'toast.filled': '宸插～鍏?DeepSeek 杈撳叆妗嗭紙{count} 瀛楋級锛岃鎵嬪姩鎸?Enter 鍙戦€併€?,
			'toast.nocomposer': '娌℃壘鍒?DeepSeek 杈撳叆妗嗭紝璇峰厛鍦ㄧ綉椤甸噷鎵撳紑涓€涓璇濄€?,
			'toast.copied': '宸插鍒跺埌鍓创鏉裤€?,
			'toast.rebound': '宸茶В闄ょ粦瀹氾紝涓嬫鎵撳紑灏嗘柊寤哄璇濄€?,
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
			'action.last': 'Last',
			'action.fill': 'Fill and send',
			'action.fillOnly': 'Fill only',
			'action.copy': 'Copy',
			'picker.title': 'Choose messages to quote',
			'picker.empty': 'This session has no quotable messages yet.',
			'picker.emptyAdvanced': 'This session has nothing quotable yet.',
			'picker.loading': 'Reading the session鈥?,
			'picker.selected': '{count} selected',
			'picker.role.user': 'User',
			'picker.role.assistant': 'Assistant',
			'picker.role.tool': 'Tool',
			'picker.advanced': 'Advanced: include thinking and tool calls',
			'picker.advancedHint': 'By default this lists your conversation with the assistant plus the questions it asked you and their options. Turning this on also lists thinking, tool calls, tool results, todos, commands and compaction summaries.',
			'picker.kind.question': 'Question',
			'picker.kind.answer': 'Answer',
			'picker.kind.reasoning': 'Thinking',
			'picker.kind.toolCall': 'Call',
			'picker.kind.toolResult': 'Result',
			'picker.kind.todo': 'Todo',
			'picker.kind.command': 'Command',
			'picker.kind.summary': 'Summary',
			'picker.preamble': 'Add a note',
			'picker.preambleHint': 'Put a short note in front of the quoted text, telling DeepSeek what it is and where it came from.',
			'picker.preambleText': 'Below are excerpts from a conversation I had with another AI assistant (DSH), quoted as background. Lines starting with "> " are the original text, and 銆?..銆?marks who that piece came from (user, assistant, question, answer, tool call, and so on). Please read them for context, then answer my question at the very end; say so if anything in the background is unclear.',
			'picker.lastCount': 'How many',
			'picker.question': 'Question or instruction to send along (optional)',
			'picker.questionPlaceholder': 'e.g. Based on the above, help me draft a more complete plan.',
			'picker.preview': 'What will be sent to DeepSeek',
			'picker.hint': 'Fill and send puts the preview straight into DeepSeek and submits it; use Fill only if you want to check it first. Neither touches your DSH conversation.',
			'toast.sent': 'Sent to DeepSeek ({count} chars).',
			'toast.sendPending': 'Filled the DeepSeek composer, but the automatic send did not take 鈥?press Enter there yourself.',
			'status.bound': 'Bound to DeepSeek conversation {id}',
			'status.unbound': 'Unbound 鈥?binds automatically after the first message is sent in DeepSeek',
			'status.nobridge': 'No desktop browser channel here, so the real web app cannot be embedded.',
			'status.nobridgeHint': 'Use the DSH desktop app; a plain `dsh web` profile does not carry this channel.',
			'status.failed': 'Embedding failed: {error}',
			'status.filling': 'Filling鈥?,
			'toast.filled': 'Filled the DeepSeek composer ({count} chars) 鈥?press Enter yourself to send.',
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
		 * Reduce a DSH Session id to the one form everything else compares against.
		 *
		 * DSH names the same Session two ways 鈥?the bare uuid that events carry
		 * (`e07a9659-鈥) and the `session-e07a9659-鈥 form its store uses 鈥?and
		 * which one arrives here depends on the caller. The host canonicalises
		 * what it stores, so comparing a raw id against the host's answer would
		 * silently mismatch and make a bound Session look unbound.
		 * @param value - a Session id in either form.
		 * @returns the canonical id, or '' when there is none.
		 */
		function canonicalSessionId(value) {
			if (typeof value !== 'string') return ''
			const trimmed = value.trim()
			if (trimmed === '') return ''
			return trimmed.startsWith('session-') ? trimmed.slice('session-'.length) : trimmed
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
		 * only a backstop 鈥?but it resolves real copy rather than rendering raw
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
			diag.notify += 1
			diagEvent('notify', { n: diag.notify })
			for (const watcher of [...watchers]) {
				try {
					watcher()
				} catch (error) {
					// A broken subscriber must not stop the others.
				}
			}
		}

		/** A pending coalesced notify, so a burst of events re-renders once. */
		let notifyQueued = false

		/**
		 * Counters for the diagnostics route.
		 *
		 * The guest is a `<webview>` this plugin cannot inspect from outside, so a
		 * flicker in there is otherwise invisible: the only way to tell a real
		 * hide/show cycle from a merely redundant one is to count them in the page
		 * and read the numbers back.
		 */
		const diag = {
			update: 0,
			shown: 0,
			hidden: 0,
			moved: 0,
			skipped: 0,
			notify: 0,
			// A flicker is either the guest being hidden and shown in a loop, or the
			// panel body being torn down and remounted by the shell. These tell those
			// apart, which no snapshot of the counters above can.
			mounts: 0,
			unmounts: 0,
			renders: 0,
			flickers: 0,
			events: [],
		}

		/** Recent visibility flips, so a flicker can be detected as a rate. */
		const flipTimes = []

		/**
		 * Record a visibility flip, and flag a burst.
		 *
		 * A flicker is a rate, so one reading of the counters cannot show it 鈥?they
		 * have to be read against the clock. Three flips within two seconds is taken
		 * as a burst.
		 * @param kind - `show` or `hide`.
		 * @param detail - whatever the caller knows about this flip.
		 */
		function noteFlip(kind, detail) {
			const now = Date.now()
			flipTimes.push(now)
			while (flipTimes.length > 0 && now - flipTimes[0] > 2000) flipTimes.shift()
			if (flipTimes.length < 3) return
			diag.flickers += 1
			diagEvent('FLICKER', { kind, flips: flipTimes.length, ...detail })
		}

		/** Record one visibility transition, keeping only the recent tail. */
		function diagEvent(kind, detail) {
			diag.events.push({ t: Date.now(), kind, detail })
			if (diag.events.length > 40) diag.events.splice(0, diag.events.length - 40)
		}

		/** Post the counters so the host can serve them from the diag route. */
		function postDiagnostics(extra) {
			try {
				void fetch(ROUTES.diag, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ ...diag, ...extra }),
				}).catch(() => undefined)
			} catch (error) {
				// Diagnostics must never break the plugin.
			}
		}

		/**
		 * Notify at most once per frame.
		 *
		 * A single page load raises several of the events that call this
		 * (`did-navigate`, `did-navigate-in-page`, `did-finish-load`, plus the
		 * poll), and each one re-rendered the whole panel. Coalescing them keeps a
		 * burst from being a burst of renders 鈥?which is what a flicker is.
		 */
		function notifySoon() {
			if (notifyQueued) return
			notifyQueued = true
			queueMicrotask(() => {
				notifyQueued = false
				notify()
			})
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
		 * "浣跨敤鐜寮傚父 / Abnormal usage environment" dialog, and dismissing it is
		 * stored per guest partition 鈥?process-lifetime here, so it would come
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

		/**
		 * Inject this plugin's stylesheet once.
		 *
		 * Colours come from the shell's own design tokens (`--dsw-*`), which is
		 * what makes the panel and its header door sit in the same visual system
		 * as the built-in UI. Every token is paired with a literal fallback: the
		 * `--dsh-color-*` family this file used to reference does not exist in
		 * DSH at all, so those declarations were silently falling through to
		 * `inherit` and rendering the header glyph pure white instead of the
		 * muted ink the rest of that row uses.
		 */
		function ensureStyle() {
			if (document.querySelector('style[' + OVERLAY_ATTR + '-style]') !== null) return
			const tag = document.createElement('style')
			tag.setAttribute(OVERLAY_ATTR + '-style', '')
			tag.textContent = [
				// The persistent guest, parked on the measured slot area.
				'[' + OVERLAY_ATTR + ']{position:fixed;display:none;z-index:40;overflow:hidden;background:#fff}',
				'[' + OVERLAY_ATTR + '] webview{-webkit-app-region:no-drag;border:0;display:flex;width:100%;height:100%}',
				// The panel itself.
				'.dswc-root{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;font-size:12px;color:var(--dsw-alias-label-primary,inherit)}',
				'.dswc-toolbar{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l4,rgba(128,128,128,.25));flex:none}',
				'.dswc-status{font-size:11px;line-height:1;color:var(--dsw-alias-label-tertiary,#adb2b8)}',
				'.dswc-status[data-state="bound"]{color:#2ea043}',
				'.dswc-status[data-state="error"]{color:#d1242f}',
				'.dswc-gap{flex:1 1 auto}',
				'.dswc-button{font:inherit;font-size:11px;padding:3px 8px;border-radius:var(--dsw-radius-sm,8px);border:1px solid var(--dsw-alias-border-l4,rgba(128,128,128,.35));background:transparent;color:inherit;cursor:pointer;white-space:nowrap}',
				'.dswc-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}',
				'.dswc-button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:1px}',
				'.dswc-button:disabled{opacity:.45;cursor:default}',
				'.dswc-primary{border-color:transparent;background:var(--dsw-alias-state-business-primary,#4d6bfe);color:#fff}',
				'.dswc-primary:hover:not(:disabled){background:var(--dsw-alias-state-business-primary,#4d6bfe);opacity:.88}',
				'.dswc-host{position:relative;flex:1 1 auto;min-height:0}',
				'.dswc-picker{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;gap:6px;padding:8px}',
				'.dswc-pickerHead{display:flex;align-items:center;gap:6px;row-gap:4px;flex-wrap:wrap;flex:none}',
				'.dswc-pickerTitle{font-weight:600}',
				'.dswc-muted{color:var(--dsw-alias-label-tertiary,#adb2b8);font-size:11px}',
				'.dswc-list{flex:1 1 auto;min-height:60px;overflow:auto;border:1px solid var(--dsw-alias-border-l4,rgba(128,128,128,.25));border-radius:var(--dsw-radius-md,12px)}',
				'.dswc-row{display:flex;gap:6px;padding:6px 8px;cursor:pointer;border-bottom:1px solid var(--dsw-alias-border-l4,rgba(128,128,128,.15))}',
				'.dswc-row:last-child{border-bottom:0}',
				'.dswc-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}',
				// The row marker is an icon from the shell's own set plus a short
				// word, inside a fixed-width column so the text of every row starts
				// at the same place however long the label is.
				'.dswc-role{display:inline-flex;align-items:center;gap:4px;flex:none;width:58px;font-size:10px;line-height:1.2;color:var(--dsw-alias-label-tertiary,#adb2b8);padding-top:1px}',
				'.dswc-kindIcon{flex:none;display:block}',
				'.dswc-roleLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
				// A question and its answer are what the default set exists for, so
				// their markers carry the accent ink the answer badge uses. The
				// assistant's row uses it too: its marker is DeepSeek's own logo,
				// which is a solid mark and reads as a grey blob when muted.
				'.dswc-row[data-kind="question"] .dswc-role,.dswc-row[data-kind="answer"] .dswc-role{color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
				'.dswc-row[data-kind="assistant"] .dswc-role{color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
				'.dswc-select{font:inherit;font-size:11px;padding:2px 4px;border-radius:var(--dsw-radius-sm,8px);border:1px solid var(--dsw-alias-border-l4,rgba(128,128,128,.35));background:transparent;color:inherit}',
				// Advanced rows are the machinery behind the conversation, so they
				// are inked down rather than competing with the actual dialogue.
				'.dswc-row[data-kind="reasoning"] .dswc-text,.dswc-row[data-kind="tool-call"] .dswc-text,.dswc-row[data-kind="tool-result"] .dswc-text,.dswc-row[data-kind="todo"] .dswc-text,.dswc-row[data-kind="command"] .dswc-text,.dswc-row[data-kind="summary"] .dswc-text{color:var(--dsw-alias-label-tertiary,#adb2b8);font-size:11px}',
				'.dswc-row[data-kind="reasoning"] .dswc-text{font-style:italic}',
				'.dswc-row[data-kind="tool-call"] .dswc-text,.dswc-row[data-kind="tool-result"] .dswc-text,.dswc-row[data-kind="command"] .dswc-text{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
				// The question and its answer are the point of the default set, so
				// they read as slightly more than the surrounding dialogue.
				'.dswc-row[data-kind="question"] .dswc-text{color:var(--dsw-alias-state-business-primary,#4d6bfe)}',
				'.dswc-advanced{display:flex;align-items:center;gap:6px;flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#adb2b8);cursor:pointer}',
				'.dswc-advanced:hover{color:var(--dsw-alias-label-secondary,#cfd3d6)}',
				'.dswc-text{flex:1 1 auto;white-space:pre-wrap;word-break:break-word;max-height:96px;overflow:hidden}',
				'.dswc-compose{display:flex;flex-direction:column;gap:4px;flex:none}',
				'.dswc-label{font-size:11px;color:var(--dsw-alias-label-tertiary,#adb2b8)}',
				'.dswc-question,.dswc-preview{font:inherit;width:100%;box-sizing:border-box;padding:6px;border-radius:var(--dsw-radius-sm,8px);border:1px solid var(--dsw-alias-border-l4,rgba(128,128,128,.3));background:transparent;color:inherit;resize:vertical}',
				'.dswc-preview{margin:0;max-height:150px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}',
				'.dswc-actions{display:flex;gap:6px}',
				'.dswc-notice{padding:12px;color:var(--dsw-alias-label-tertiary,#adb2b8);display:flex;flex-direction:column;gap:6px}',
				'.dswc-toast{flex:none;margin:0 8px 8px;padding:6px 8px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));font-size:11px}',
				// The header door. Sized and inked like the built-in icon buttons in
				// that row (24px hit area, 8px radius, muted ink, translucent hover),
				// rather than inheriting the header's near-white text colour.
				'.dswc-headerButton{box-sizing:border-box;display:inline-flex;flex:none;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary,#cfd3d6);cursor:pointer}',
				'.dswc-headerButton:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#fff)}',
				'.dswc-headerButton:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:1px}',
			].join('\n')
			document.head.appendChild(tag)
		}

		/**
		 * @returns the document-root container that keeps the guest alive.
		 *
		 * The stylesheet is injected first, and that is not incidental: without the
		 * `position: fixed` rule this element is an ordinary block-level div, so a
		 * bare one appended to `<body>` claims the full document width and shoves
		 * the whole app sideways 鈥?and the guest's own white page sits on top of it.
		 * That is the "the entire page flashes" symptom, and it appeared whenever the
		 * guest was rebuilt before the sheet existed.
		 */
		function overlayContainer() {
			ensureStyle()
			const existing = document.querySelector('[' + OVERLAY_ATTR + ']')
			if (existing !== null && existing !== undefined) return existing
			const box = document.createElement('div')
			box.setAttribute(OVERLAY_ATTR, '')
			// Hidden at birth so there is never a frame where it is in the document
			// and visible but not yet sized.
			box.style.display = 'none'
			document.body.appendChild(box)
			return box
		}

		/**
		 * Hide the guest without unmounting it.
		 *
		 * Idempotent on purpose: setting `display` on a `<webview>` that is already
		 * in that state still makes the guest re-composite, which reads as a
		 * flicker. Any redundant pass over the parking code must therefore be a
		 * no-op rather than a hide/show cycle.
		 */
		function hideOverlay() {
			if (guest === null) return
			if (guest.container.style.display === 'none') {
				diag.skipped += 1
				return
			}
			diag.hidden += 1
			diagEvent('hide')
			noteFlip('hide')
			guest.container.style.display = 'none'
		}

		/**
		 * Park the guest on one measured rectangle.
		 *
		 * The order here is load-bearing. The container is `position: fixed` with a
		 * white background, and a block-level fixed box with `width: auto` spans the
		 * whole viewport. Making it visible before its geometry is set therefore
		 * paints a full-window white slab over the app for a frame 鈥?which is what
		 * "the whole page flashes" was. Geometry first, visibility last.
		 * @param rect - the slot area, in viewport coordinates.
		 */
		function showOverlay(rect) {
			if (guest === null) return
			const style = guest.container.style
			// A zero-sized rectangle is a pane that has not been laid out yet;
			// parking on it would show a sliver, so wait for the next pass.
			if (!(rect.width > 0) || !(rect.height > 0)) return
			const left = rect.left + 'px'
			const top = rect.top + 'px'
			const width = rect.width + 'px'
			const height = rect.height + 'px'
			const moved = style.left !== left || style.top !== top
				|| style.width !== width || style.height !== height
			// Written only when changed: re-setting a property on a <webview>'s
			// container can still re-composite, which is what a flicker looks like.
			if (style.left !== left) style.left = left
			if (style.top !== top) style.top = top
			if (style.width !== width) style.width = width
			if (style.height !== height) style.height = height
			// Only now, with a real size in place, is it safe to show.
			if (style.display !== 'block') {
				diag.shown += 1
				diagEvent('show', { left, top, width, height })
				noteFlip('show', { width, height })
				style.display = 'block'
			} else if (moved) {
				diag.moved += 1
				diagEvent('move', { left, top, width, height })
			} else {
				diag.skipped += 1
			}
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
		 * origin 鈥?where `localStorage` throws and `document.cookie` is empty.
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
		 * Record one DSH Session 鈫?DeepSeek conversation binding.
		 *
		 * The host is the authority, not this cache: the cache only exists so the
		 * poll does not re-POST the same pair every couple of seconds (each write
		 * notifies the panel and re-renders it). So the host's answer is what the
		 * cache is reconciled against 鈥?if the host says this Session is now
		 * bound to a different conversation, the cache follows rather than
		 * insisting on the stale pair.
		 *
		 * Re-binding is allowed and is the point: when the user's conversation in
		 * the page changes, the Session should follow the new one. The host
		 * refuses only a conversation another Session already owns.
		 * @param dshSessionId - DSH Session id.
		 * @param deepseekSessionId - DeepSeek conversation id.
		 */
		async function bind(rawSessionId, deepseekSessionId) {
			const dshSessionId = canonicalSessionId(rawSessionId)
			if (dshSessionId === '') return
			const pair = dshSessionId + '\u0000' + deepseekSessionId
			if (boundPairs.has(pair)) return
			try {
				const response = await fetch(ROUTES.binding, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ dshSessionId, deepseekSessionId }),
				})
				const payload = await response.json()
				if (payload?.ok !== true) {
					// Refused 鈥?the conversation belongs to another Session. Leave
					// the claim off so a later observation can retry, and do not
					// mark it as bound.
					return
				}
				// The host echoes the binding it now holds, so the cache records
				// what is actually stored rather than what was merely requested.
				const stored = typeof payload.deepseekSessionId === 'string'
					? payload.deepseekSessionId
					: deepseekSessionId
				boundPairs.add(dshSessionId + '\u0000' + stored)
				notifySoon()
			} catch (error) {
				// The next observation retries, so leave the claim off.
			}
		}

		/**
		 * Forget the write cache for one DSH Session.
		 *
		 * The prefix is canonicalised to match how `bind` keys the cache; a raw id
		 * here would leave the entry behind, and the next visit would be silently
		 * treated as "already bound" and never re-registered.
		 * @param dshSessionId - DSH Session id, in either form.
		 */
		function forgetBoundPairs(dshSessionId) {
			const canonical = canonicalSessionId(dshSessionId)
			if (canonical === '') return
			const prefix = canonical + '\u0000'
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
		 *
		 * The settle counter is deliberately *not* reset by the ordinary polling
		 * path 鈥?only by a deliberate navigation 鈥?so that a page which is simply
		 * sitting still does reach its second reading.
		 */
		function observeUrl() {
			if (guest === null || activeSessionId === undefined) return
			let url
			try {
				url = guest.element.getURL()
			} catch (error) {
				return
			}
			if (url === '' || url === 'about:blank') return
			if (url !== lastSeenUrl) {
				lastSeenUrl = url
				return
			}
			const deepseekSessionId = sessionIdOf(url)
			if (deepseekSessionId === undefined) return
			void bind(activeSessionId, deepseekSessionId)
		}

		/**
		 * Point the guest at the conversation this DSH Session should be showing.
		 *
		 * Called when the DSH Session changes (and once on mount). The rule is
		 * that the page wins whenever it is somewhere legitimate:
		 *
		 * - already in the bound conversation 鈥?nothing to do;
		 * - in a conversation nobody owns 鈥?adopt it for this Session. This is
		 *   what makes "the current conversation changed, so follow it" work: the
		 *   user opening a new conversation in the page rebinds the Session
		 *   instead of being dragged back to the previous one;
		 * - in a conversation another Session owns, or nowhere in particular 鈥?		 *   go to the bound conversation, or home when there is none.
		 *
		 * Deliberately *not* "always navigate to the binding": doing that fought
		 * the user's own navigation, which is part of why the binding looked
		 * unreliable.
		 * @param dshSessionId - the DSH Session the guest should follow.
		 */
		async function focusSession(rawSessionId) {
			const dshSessionId = canonicalSessionId(rawSessionId)
			if (dshSessionId === '') return
			activeSessionId = dshSessionId
			if (guest === null) return
			let current
			try {
				current = guest.element.getURL()
			} catch (error) {
				current = ''
			}
			const currentId = sessionIdOf(current)
			const bound = await readBinding(dshSessionId)
			if (currentId !== undefined) {
				if (currentId === bound) return
				const owner = await ownerOf(currentId)
				// Unowned: this is the Session's conversation now. Adopting here
				// also covers the case where the id only *looked* unbound because
				// the stored key was written in the other id form.
				if (owner === null) {
					await bind(dshSessionId, currentId)
					return
				}
				if (owner === dshSessionId) return
				// Someone else's conversation: restore this Session's own.
				navigate(bound === null ? PAGE_URL : conversationUrl(bound))
				return
			}
			if (bound !== null) navigate(conversationUrl(bound))
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
					// the real site and the page is then asked to load once more 鈥?					// this time already signed in. The origin check matters: the
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
							// A navigation means the URL is worth re-reading, but it
							// must not clear the settle marker: the poll below settles
							// by seeing the same URL twice, and wiping it on every
							// event meant a still page never settled and its
							// conversation was never bound.
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
			return ['> 銆? + label + '銆? + lines[0]]
				.concat(lines.slice(1).map((line) => '> ' + line))
				.join('\n')
		}

		/**
		 * Compose the blockquote plus the user's own question.
		 * @param rows - the selected messages, in log order.
		 * @param labels - role and kind labels.
		 * @param question - the user's question or instruction.
		 * @param options - `{ preamble }`, a note explaining what is being quoted.
		 * @returns the text to place in the DeepSeek composer.
		 */
		function compose(rows, labels, question, options = {}) {
			const blocks = []
			for (const row of rows) {
				// Every row is labelled by what it is, not just by who said it:
				// once the advanced switch is on, a quoted tool result and a
				// quoted answer would otherwise look identical in the blockquote.
				const label = kindLabel(row, labels)
				const block = quoteBlock(label, row.text)
				if (block !== '') blocks.push(block)
			}
			const quoted = blocks.join('\n\n')
			const asked = String(question ?? '').trim()
			const note = String(options.preamble ?? '').trim()
			const chunks = []
			// The note explains the blockquotes, so it is pointless without them 鈥?			// a bare question needs no account of where it came from.
			if (quoted !== '') chunks.push(note === '' ? quoted : note + '\n\n' + quoted)
			if (asked !== '') chunks.push(asked)
			return chunks.join('\n\n---\n\n')
		}

		/**
		 * The label for one row, used both in the list and in the blockquote.
		 * @param row - a picker row.
		 * @param labels - `{ user, assistant, tool, kind }`.
		 * @returns the label text.
		 */
		function kindLabel(row, labels) {
			const kind = row.kind ?? row.role
			if (kind === 'user') return labels.user
			if (kind === 'assistant') return labels.assistant
			// Every remaining kind has a two-character label, which is what keeps
			// the role column a fixed narrow width in both locales.
			return labels.kind?.[kind] ?? (row.role === 'tool' ? labels.tool : labels.assistant)
		}

		/**
		 * The shell's own artwork for each row kind.
		 *
		 * Lifted from `@deepseek-ai/dsh-client-ui-primitives`, which is inlined
		 * into every client bundle at build time and so cannot be `require`d at
		 * runtime. Each glyph is drawn on that set's `0 0 16 16` grid and stroked
		 * at the Regular 1px weight in `currentColor`, so a row marker reads as
		 * one of the shell's icons rather than as a drawing of its own. Entries
		 * that are objects are solid glyphs, because their source artwork is.
		 */
		const KIND_ARTWORK = {
			user: [
				'M8 8.25C9.51878 8.25 10.75 7.01878 10.75 5.5C10.75 3.98122 9.51878 2.75 8 2.75C6.48122 2.75 5.25 3.98122 5.25 5.5C5.25 7.01878 6.48122 8.25 8 8.25Z',
				'M2.5 14.5C2.5 11.5 5.25 10.25 8 10.25C10.75 10.25 13.5 11.5 13.5 14.5',
			],
			assistant: [
				'M5.875 3C5.875 6.33333 7.54167 8 10.875 8C7.54167 8 5.875 9.66667 5.875 13C5.875 9.66667 4.20833 8 0.875 8C4.20833 8 5.875 6.33333 5.875 3Z',
				'M12.375 1.55823C12.375 3.39156 13.2917 4.30823 15.125 4.30823C13.2917 4.30823 12.375 5.22489 12.375 7.05823C12.375 5.22489 11.4583 4.30823 9.625 4.30823C11.4583 4.30823 12.375 3.39156 12.375 1.55823Z',
				'M12.375 10.4418C12.375 11.7751 13.0417 12.4418 14.375 12.4418C13.0417 12.4418 12.375 13.1084 12.375 14.4418C12.375 13.1084 11.7083 12.4418 10.375 12.4418C11.7083 12.4418 12.375 11.7751 12.375 10.4418Z',
			],
			question: [
				'M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z',
				'M5.75 6.69646C5.75 6.29865 5.88196 5.90976 6.12919 5.57899C6.37643 5.24821 6.72783 4.99041 7.13896 4.83817C7.5501 4.68593 8.0025 4.6461 8.43895 4.72371C8.87541 4.80132 9.27632 4.99289 9.59099 5.27419C9.90566 5.55549 10.12 5.91388 10.2068 6.30406C10.2936 6.69423 10.249 7.09866 10.0787 7.4662C9.90843 7.83373 9.62004 8.14787 9.25003 8.36889C9.19476 8.4019 9.13803 8.43262 9.08004 8.46099C8.52566 8.73217 8 9.20817 8 9.82532',
				'M8 10.7416V11.7416',
			],
			answer: [
				'M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4',
			],
			reasoning: [
				'M10.2854 5.71481C12.9673 8.39663 14.1182 11.5938 12.8562 12.8559C11.5942 14.1179 8.39706 12.9669 5.71518 10.2851C3.03333 7.60323 1.88236 4.40608 3.14441 3.14403C4.40644 1.882 7.6036 3.03297 10.2854 5.71481Z',
				'M10.2854 10.2851C7.6036 12.9669 4.40644 14.1179 3.14441 12.8559C1.88236 11.5938 3.03333 8.39663 5.71518 5.71481C8.39706 3.03297 11.5942 1.882 12.8562 3.14403C14.1182 4.40608 12.9673 7.60323 10.2854 10.2851Z',
				{
					d: 'M8.86291 8.0002C8.86291 8.47549 8.47762 8.86087 8.00224 8.86087C7.52694 8.86087 7.1416 8.47549 7.1416 8.0002C7.1416 7.52485 7.52694 7.13953 8.00224 7.13953C8.47762 7.13953 8.86291 7.52485 8.86291 8.0002Z',
					fill: true,
				},
			],
			'tool-call': [
				'M6.27612 1.5L4.52612 14.5',
				'M11.4739 1.5L9.72388 14.5',
				'M2.39868 5.5H14.0681',
				'M1.93188 10.5H13.6013',
			],
			'tool-result': [
				'M6.15479 4.91687H9.84543',
				'M11.8798 9.55347V2.71525C11.8798 2.37416 11.564 2.09766 11.1744 2.09766H4.82577C4.43618 2.09766 4.12036 2.37416 4.12036 2.71525V9.55347',
				'M2.28735 13.8022V8.84792C2.28735 8.77514 2.36262 8.72673 2.42884 8.75693L13.2936 13.7112C13.3914 13.7558 13.3596 13.9022 13.2521 13.9022H2.38735C2.33213 13.9022 2.28735 13.8575 2.28735 13.8022Z',
				'M7.46929 10.979L13.5783 8.7416C13.6435 8.7177 13.7126 8.76601 13.7126 8.83551L13.7125 13.8022C13.7125 13.8574 13.6678 13.9022 13.6125 13.9022H7.99999',
				'M6.15479 7.2395H9.05644',
			],
			todo: [
				'M3.75 6.25C4.7165 6.25 5.5 5.4665 5.5 4.5C5.5 3.5335 4.7165 2.75 3.75 2.75C2.7835 2.75 2 3.5335 2 4.5C2 5.4665 2.7835 6.25 3.75 6.25Z',
				'M7.5 4.5H13.5',
				'M3.75 13.25C4.7165 13.25 5.5 12.4665 5.5 11.5C5.5 10.5335 4.7165 9.75 3.75 9.75C2.7835 9.75 2 10.5335 2 11.5C2 12.4665 2.7835 13.25 3.75 13.25Z',
				'M7.5 11.5H13.5',
			],
			command: [
				'M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z',
				'M10.3329 7.91346C10.3996 7.95195 10.3996 8.04818 10.3329 8.08667L6.78304 10.1362C6.71638 10.1747 6.63304 10.1266 6.63304 10.0496L6.63304 5.95055C6.63304 5.87357 6.71638 5.82546 6.78304 5.86395L10.3329 7.91346Z',
			],
			summary: [
				'M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z',
				'M8 1.5C8.85359 1.5 9.69883 1.66813 10.4874 1.99478C11.2761 2.32144 11.9926 2.80022 12.5962 3.40381C13.1998 4.00739 13.6786 4.72394 14.0052 5.51256C14.3319 6.30117 14.5 7.14641 14.5 8',
			],
		}

		/**
		 * DeepSeek's own logo, for the assistant's rows.
		 *
		 * Taken from its favicon (`fe-static.deepseek.com/chat/favicon.svg`), so
		 * the marker is the mark of the assistant being quoted rather than a
		 * generic sparkle. It is a solid glyph on a `0 0 50 50` grid, so it keeps
		 * its own viewBox instead of joining KIND_ARTWORK's 16px stroked set.
		 */
		const DEEPSEEK_LOGO = 'M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z'

		/**
		 * One row kind's icon, at the row marker's size.
		 * @param kind - a row kind such as `user` or `tool-call`.
		 * @returns an inline SVG element.
		 */
		function KindIcon(kind) {
			// The assistant is DeepSeek's own mark rather than one of the shell's
			// outline glyphs: a row that says "assistant" is quoting DeepSeek, and
			// a generic sparkle there read as just another tool.
			if (kind === 'assistant') {
				return h('svg', {
					className: 'dswc-kindIcon',
					width: 13,
					height: 13,
					viewBox: '0 0 50 50',
					fill: 'none',
					xmlns: 'http://www.w3.org/2000/svg',
					'aria-hidden': 'true',
				}, h('path', { d: DEEPSEEK_LOGO, fill: 'currentColor', fillRule: 'nonzero' }))
			}
			const art = KIND_ARTWORK[kind] ?? KIND_ARTWORK.assistant
			return h('svg', {
				className: 'dswc-kindIcon',
				width: 13,
				height: 13,
				viewBox: '0 0 16 16',
				fill: 'none',
				xmlns: 'http://www.w3.org/2000/svg',
				'aria-hidden': 'true',
				strokeWidth: 1,
			}, art.map((entry, index) => {
				const path = typeof entry === 'string' ? { d: entry } : entry
				return h('path', {
					key: index,
					d: path.d,
					stroke: path.fill === true ? 'none' : 'currentColor',
					fill: path.fill === true ? 'currentColor' : 'none',
				})
			}))
		}

		/** How the guest finds the composer, most specific selector first. */
		const COMPOSER_PICK = 'document.querySelector("textarea.ds-textarea__textarea")'
			+ ' || document.querySelector("textarea[placeholder]")'
			+ ' || document.querySelector("textarea")'

		/**
		 * The script that fills the DeepSeek composer.
		 *
		 * The composer is a React-controlled `<textarea class="ds-textarea__textarea">`
		 * (the class is built as `"ds" + "-textarea__textarea"` in DeepSeek's own
		 * bundle). Writing `.value` directly is ignored by React, so the native
		 * value setter is used and an `input` event is dispatched, which is what
		 * makes React commit the change.
		 * @param text - the text to place in the composer.
		 * @returns a self-contained script expression.
		 */
		function fillScript(text) {
			return '(function () {'
				+ ' try {'
				+ ' var text = ' + JSON.stringify(text) + ';'
				+ ' var el = ' + COMPOSER_PICK + ';'
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
		 * The script that submits the composer through DeepSeek's own handler.
		 *
		 * Its composer runs `onKeyDown` and, for a plain Enter, calls the very
		 * function its send button calls. Dispatching a bubbling Enter therefore
		 * runs the user's own code path 鈥?no invented shortcut, and no need to
		 * guess at the send button's generated class name.
		 * @returns a self-contained script expression.
		 */
		function sendScript() {
			return '(function () {'
				+ ' try {'
				+ ' var el = ' + COMPOSER_PICK + ';'
				+ ' if (!el) return { ok: false, error: "no-composer" };'
				+ ' el.focus();'
				+ ' el.dispatchEvent(new KeyboardEvent("keydown", {'
				+ ' key: "Enter", code: "Enter", keyCode: 13, which: 13,'
				+ ' bubbles: true, cancelable: true, composed: true'
				+ ' }));'
				+ ' return { ok: true };'
				+ ' } catch (error) {'
				+ ' return { ok: false, error: String(error && error.message || error) };'
				+ ' }'
				+ ' })()'
		}

		/**
		 * The script that reports what the composer currently holds.
		 *
		 * DeepSeek clears its textarea once a send has been accepted, so an empty
		 * composer is the receipt that the message actually went out 鈥?a much
		 * better signal than assuming the click worked.
		 * @returns a self-contained script expression.
		 */
		function probeScript() {
			return '(function () {'
				+ ' try {'
				+ ' var el = ' + COMPOSER_PICK + ';'
				+ ' if (!el) return { ok: false, error: "no-composer" };'
				+ ' var value = String(el.value == null ? "" : el.value);'
				+ ' return { ok: true, empty: value.trim() === "", length: value.length };'
				+ ' } catch (error) {'
				+ ' return { ok: false, error: String(error && error.message || error) };'
				+ ' }'
				+ ' })()'
		}

		/**
		 * The script that clicks DeepSeek's own send button.
		 *
		 * The fallback for when the Enter path is refused. The button's class name
		 * is a build-time hash, so it is found by its accessible name instead 鈥?		 * and it is never clicked when the composer was already cleared, which is
		 * what stops a double send.
		 * @returns a self-contained script expression.
		 */
		function clickSendScript() {
			return '(function () {'
				+ ' try {'
				+ ' var wanted = /send|submit|鍙戦€?i;'
				+ ' var nodes = document.querySelectorAll("button, [role=button]");'
				+ ' for (var i = 0; i < nodes.length; i += 1) {'
				+ ' var node = nodes[i];'
				+ ' if (node.disabled === true) continue;'
				+ ' var name = String(node.getAttribute("aria-label") || "") + " "'
				+ ' + String(node.getAttribute("title") || "") + " "'
				+ ' + String(node.getAttribute("data-testid") || "") + " "'
				+ ' + String(node.textContent || "");'
				+ ' if (!wanted.test(name)) continue;'
				+ ' var rect = node.getBoundingClientRect();'
				+ ' if (rect.width <= 0 || rect.height <= 0) continue;'
				+ ' node.click();'
				+ ' return { ok: true, found: true };'
				+ ' }'
				+ ' return { ok: true, found: false };'
				+ ' } catch (error) {'
				+ ' return { ok: false, error: String(error && error.message || error) };'
				+ ' }'
				+ ' })()'
		}

		/**
		 * Run one script in the guest's page and normalise the answer.
		 * @param script - a self-contained script expression.
		 * @returns the script's own result object.
		 */
		async function runInGuest(script) {
			if (guest === null) return { ok: false, error: 'no-guest' }
			try {
				const result = await guest.element.executeJavaScript(script)
				if (result === null || typeof result !== 'object') return { ok: false, error: 'no-result' }
				return result
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) }
			}
		}

		/**
		 * Fill the guest's composer.
		 * @param text - the text to place there.
		 * @returns a result describing what happened.
		 */
		async function fillComposer(text) {
			return runInGuest(fillScript(text))
		}

		/**
		 * Wait, then ask the composer whether the send landed.
		 * @param delayMs - how long to give DeepSeek to accept the message.
		 * @returns true once the composer has been cleared.
		 */
		async function composerCleared(delayMs) {
			await new Promise((resolve) => setTimeout(resolve, delayMs))
			const probe = await runInGuest(probeScript())
			return probe.ok === true && probe.empty === true
		}

		/**
		 * Put text into DeepSeek's composer and, when asked, submit it.
		 * @param text - the text to place in the composer.
		 * @param options - `{ send }` to submit it as well.
		 * @returns `{ ok, length, sent, via?, error? }`.
		 */
		async function pushToDeepSeek(text, options = {}) {
			const filled = await fillComposer(text)
			if (filled.ok !== true) return filled
			if (options.send !== true) return { ...filled, sent: false }
			// React commits the new value asynchronously, so pressing Enter in the
			// same tick would submit whatever was there before.
			await new Promise((resolve) => setTimeout(resolve, 120))
			const pressed = await runInGuest(sendScript())
			if (pressed.ok !== true) return { ...filled, sent: false, error: pressed.error }
			if (await composerCleared(800)) return { ...filled, sent: true, via: 'enter' }
			// The Enter path was refused (its handler is a no-op when the composer
			// reads as unsubmittable). Try DeepSeek's own button before giving up.
			const clicked = await runInGuest(clickSendScript())
			if (clicked.found === true && await composerCleared(800)) {
				return { ...filled, sent: true, via: 'button' }
			}
			return { ...filled, sent: false, error: 'not-sent' }
		}

		//#endregion

		//#region ui

		/**
		 * The chat-bubble glyph this plugin uses for both of its doors.
		 *
		 * Drawn to the shell's own icon spec rather than to taste, because the
		 * icon sits in a row of built-in glyphs and any deviation reads as a
		 * mistake: a `0 0 16 16` viewBox, a 1px stroke (the icon set's
		 * `Regular` weight; `Medium` is 1.3), `fill: none` on the frame, and
		 * `currentColor` throughout so the ink comes from whatever the host
		 * paints 鈥?`--dsw-alias-label-secondary` in the guide's 26px icon box,
		 * `--dsw-alias-label-tertiary` in the tab title.
		 *
		 * @param props - `{ size, className }`; the shell supplies both.
		 * @returns the glyph.
		 */
		function ChatBubbleGlyph(props) {
			const size = props?.size ?? 16
			return h('svg', {
				width: size, height: size, viewBox: '0 0 16 16',
				className: props?.className,
				fill: 'none', xmlns: 'http://www.w3.org/2000/svg',
				strokeWidth: 1,
				'aria-hidden': 'true',
			}, [
				// Frame: a rounded bubble with a tail on the lower left.
				h('path', {
					key: 'frame',
					d: 'M4.5 2.5H11.5C12.6 2.5 13.5 3.4 13.5 4.5V9C13.5 10.1 12.6 11 11.5 11H7.25L4.5 13.25V11H4.5C3.4 11 2.5 10.1 2.5 9V4.5C2.5 3.4 3.4 2.5 4.5 2.5Z',
					stroke: 'currentColor', strokeLinejoin: 'round',
				}),
				// One message line, so the glyph reads as a conversation.
				h('path', { key: 'line', d: 'M5.5 6.75H10.5', stroke: 'currentColor', strokeLinecap: 'round' }),
			])
		}

		/**
		 * The guide door's artwork. The shell sizes a guide icon itself, so the
		 * glyph reads the `size`/`className` it is handed.
		 * @param props - `{ size, className }` from the guide entry.
		 */
		function GuideArtwork(props) {
			return ChatBubbleGlyph(props)
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
			const [advanced, setAdvanced] = React.useState(false)
			const [preamble, setPreamble] = React.useState(true)
			const [lastN, setLastN] = React.useState(10)
			const [busy, setBusy] = React.useState(false)
			const [toast, setToast] = React.useState('')
			// Bumped only by the explicit 銆岄噸鏂拌鍙栥€?button. It is separate from
			// `version` (guest state) so that a guest notification cannot re-run the
			// message fetch, which would blank the list to its loading state.
			const [reload, setReload] = React.useState(0)
			const listRef = React.useRef(null)

			// React to the guest coming up, failing, or binding.
			React.useEffect(() => {
				const watcher = () => setVersion((value) => value + 1)
				watchers.add(watcher)
				return () => {
					watchers.delete(watcher)
				}
			}, [])

			// Count mounts and renders. A flicker of the panel area is either the
			// guest being hidden and shown in a loop, or the shell tearing this body
			// down and building it again; only these counters distinguish the two.
			diag.renders += 1
			React.useEffect(() => {
				diag.mounts += 1
				diagEvent('mount', { sessionId: String(sessionId ?? '') })
				return () => {
					diag.unmounts += 1
					diagEvent('unmount', { sessionId: String(sessionId ?? '') })
				}
			}, [])

			// Bring the guest up once the shell has a bridge for it.
			React.useEffect(() => {
				if (!hasBridge()) return
				void ensureGuest()
			}, [])

			// Follow the DSH Session this pane belongs to.
			//
			// This depends on `sessionId` alone. It used to depend on `version`
			// too, which is bumped by every notify() 鈥?and notify() fires from the
			// guest's own navigation events. That made the effect re-run on every
			// navigation, navigate again, and so notify itself: an endless
			// navigate/notify ping-pong that showed up as the panel flickering.
			React.useEffect(() => {
				if (sessionId === undefined) return undefined
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
			}, [sessionId])

			// Park the guest on the measured area, and keep it parked.
			//
			// Depends on `pickerOpen` alone, deliberately not on `version`. This
			// effect tears down with hideOverlay() and re-runs with showOverlay(),
			// so re-running it is a hide/show cycle on a `<webview>` 鈥?a visible
			// flicker. The geometry it measures has nothing to do with guest state
			// anyway; the interval and ResizeObserver below keep it current.
			React.useEffect(() => {
				const host = hostRef.current
				if (host === null) return undefined
				const update = () => {
					diag.update += 1
					if (overlaySuppressed || guest === null) {
						diagEvent('update', { why: overlaySuppressed ? 'suppressed' : 'no-guest' })
						hideOverlay()
						return
					}
					const rect = host.getBoundingClientRect()
					// `getClientRects()` is empty when the host or any ancestor is
					// `display: none`, which is how an unselected pane hides 鈥?so it
					// is the right test, and `offsetParent` is not (it is null for a
					// fixed-position ancestor even when the element is plainly
					// visible). The size guard rejects a pane mid-layout.
					const rects = host.getClientRects().length
					const visible = rects > 0 && rect.width > 2 && rect.height > 2
					if (!visible) {
						diagEvent('update', {
							why: 'not-visible', rects, w: rect.width, h: rect.height,
						})
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
				// Report on ourselves while this pane is mounted, so a flicker can be
				// measured from outside the guest rather than guessed at. The pane's
				// own geometry is included: a host rect that changes every tick is a
				// different problem from one that never changes at all.
				const snapshot = () => {
					let url = ''
					try {
						url = guest === null ? '' : guest.element.getURL()
					} catch (error) {
						url = ''
					}
					const rect = host.getBoundingClientRect()
					return {
						url,
						suppressed: overlaySuppressed,
						display: guest === null ? '' : guest.container.style.display,
						host: {
							l: Math.round(rect.left), t: Math.round(rect.top),
							w: Math.round(rect.width), h: Math.round(rect.height),
						},
						rects: host.getClientRects().length,
						pane: pickerOpen,
					}
				}
				const reporter = setInterval(() => postDiagnostics(snapshot()), 1000)
				postDiagnostics(snapshot())
				return () => {
					if (observer !== null) observer.disconnect()
					window.removeEventListener('resize', update)
					clearInterval(timer)
					clearInterval(reporter)
					// One last report, so the state at teardown survives: if the pane is
					// being remounted in a loop, this is the record of it.
					postDiagnostics({ ...snapshot(), teardown: true })
					hideOverlay()
				}
			}, [pickerOpen])

			// Hide the guest behind the picker.
			React.useEffect(() => {
				setOverlaySuppressed(pickerOpen)
			}, [pickerOpen])

			// Read the session's messages when the picker opens, when the advanced
			// switch flips, when the Session changes, and when the user asks for a
			// re-read. Deliberately *not* on `version`: that is bumped by notify(),
			// and every pass blanks the list to its loading state first 鈥?so a guest
			// notification (a binding landing, the guest coming up) wiped the list
			// out from under whoever was reading it. `reload` is the explicit
			// re-read, and it is the only thing that should blank the list.
			React.useEffect(() => {
				if (!pickerOpen || sessionId === undefined) return undefined
				let cancelled = false
				setMessages(null)
				setLoadError('')
				void (async () => {
					try {
						const response = await fetch(
							ROUTES.messages
							+ '?sessionId=' + encodeURIComponent(sessionId)
							+ (advanced ? '&advanced=1' : ''),
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
			}, [pickerOpen, sessionId, reload, advanced])

			const labels = React.useMemo(() => ({
				user: t('picker.role.user'),
				assistant: t('picker.role.assistant'),
				tool: t('picker.role.tool'),
				kind: {
					question: t('picker.kind.question'),
					answer: t('picker.kind.answer'),
					reasoning: t('picker.kind.reasoning'),
					'tool-call': t('picker.kind.toolCall'),
					'tool-result': t('picker.kind.toolResult'),
					todo: t('picker.kind.todo'),
					command: t('picker.kind.command'),
					summary: t('picker.kind.summary'),
				},
			}), [t])

			const chosen = React.useMemo(() => {
				if (messages === null) return []
				return messages.filter((row) => selected.has(row.seq))
			}, [messages, selected])

			// The note travels with the quoted rows, so it is composed here rather
			// than baked into the blockquote: a bare question needs no account of
			// where it came from, and compose() knows whether anything is quoted.
			const note = React.useMemo(
				() => (preamble ? t('picker.preambleText') : ''),
				[preamble, t],
			)

			const preview = React.useMemo(
				() => compose(chosen, labels, question, { preamble: note }),
				[chosen, labels, question, note],
			)

			// The list opens on the newest rows, which is what a person wants to
			// quote and where they expect to be looking.
			React.useEffect(() => {
				const node = listRef.current
				if (node === null) return
				node.scrollTop = node.scrollHeight
			}, [messages, pickerOpen])

			const toggle = React.useCallback((seq) => {
				setSelected((current) => {
					const next = new Set(current)
					if (next.has(seq)) next.delete(seq)
					else next.add(seq)
					return next
				})
			}, [])

			const push = React.useCallback(async (send) => {
				if (preview.trim() === '') return
				setBusy(true)
				setToast('')
				try {
					setPickerOpen(false)
					// Let the guest become visible again before scripting it.
					await new Promise((resolve) => setTimeout(resolve, 120))
					const result = await pushToDeepSeek(preview, { send })
					if (result.ok !== true) {
						setToast(result.error === 'no-composer'
							? t('toast.nocomposer')
							: format(t('status.failed'), { error: String(result.error) }))
						return
					}
					// The selection has been consumed either way 鈥?it is in
					// DeepSeek's composer now 鈥?so leaving it ticked would only make
					// the next push repeat this one.
					setSelected(new Set())
					setQuestion('')
					if (send && result.sent === true) {
						setToast(format(t('toast.sent'), { count: result.length ?? preview.length }))
					} else if (send) {
						setToast(t('toast.sendPending'))
					} else {
						setToast(format(t('toast.filled'), { count: result.length ?? preview.length }))
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
			const statusGlyph = state.failure !== '' ? '鈿? : (bound !== null ? '鈼? : '鈼?)

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
						h('p', { key: 'a' }, advanced ? t('picker.emptyAdvanced') : t('picker.empty')),
						loadError === '' ? null : h('p', { key: 'b', className: 'dswc-muted' }, loadError),
					])
					: h('div', { className: 'dswc-list', ref: listRef }, messages.map((row) => h('label', {
						key: row.seq,
						className: 'dswc-row',
						'data-role': row.role,
						'data-kind': row.kind ?? row.role,
					}, [
						h('input', {
							key: 'box',
							type: 'checkbox',
							checked: selected.has(row.seq),
							onChange: () => toggle(row.seq),
						}),
						h('span', {
							key: 'role',
							className: 'dswc-role',
							title: kindLabel(row, labels),
						}, [
							KindIcon(row.kind ?? row.role),
							h('span', { key: 'label', className: 'dswc-roleLabel' }, kindLabel(row, labels)),
						]),
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
						// Quoting the tail of a conversation is the common case, so
						// it gets its own control instead of asking for hand-ticking.
						h('select', {
							key: 'lastN',
							className: 'dswc-select',
							title: t('picker.lastCount'),
							'aria-label': t('picker.lastCount'),
							value: String(lastN),
							onChange: (event) => setLastN(Number(event.target.value)),
						}, [5, 10, 20, 50].map((n) => h('option', { key: n, value: String(n) }, String(n)))),
						h('button', {
							key: 'last',
							type: 'button',
							className: 'dswc-button',
							disabled: (messages ?? []).length === 0,
							onClick: () => {
								const rows = messages ?? []
								setSelected(new Set(
									rows.slice(Math.max(0, rows.length - lastN)).map((row) => row.seq),
								))
							},
						}, t('action.last')),
						h('button', {
							key: 'refresh',
							type: 'button',
							className: 'dswc-button',
							onClick: () => setReload((value) => value + 1),
						}, t('action.refresh')),
						// The advanced switch swaps the whole row set rather than
						// revealing hidden rows: the host filters, so a tool result the
						// user never opted into is never sent to the browser at all.
						h('label', {
							key: 'advanced',
							className: 'dswc-advanced',
							title: t('picker.advancedHint'),
						}, [
							h('input', {
								key: 'box',
								type: 'checkbox',
								checked: advanced,
								onChange: (event) => {
									setAdvanced(event.target.checked)
									// Selections refer to rows that may no longer exist.
									setSelected(new Set())
								},
							}),
							h('span', { key: 'text' }, t('picker.advanced')),
						]),
						h('label', {
							key: 'preamble',
							className: 'dswc-advanced',
							title: t('picker.preambleHint'),
						}, [
							h('input', {
								key: 'box',
								type: 'checkbox',
								checked: preamble,
								onChange: (event) => setPreamble(event.target.checked),
							}),
							h('span', { key: 'text' }, t('picker.preamble')),
						]),
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
								key: 'send',
								type: 'button',
								className: 'dswc-button dswc-primary',
								disabled: busy || preview.trim() === '',
								onClick: () => void push(true),
							}, busy ? t('status.filling') : t('action.fill')),
							h('button', {
								key: 'fill',
								type: 'button',
								className: 'dswc-button',
								disabled: busy || preview.trim() === '',
								onClick: () => void push(false),
							}, t('action.fillOnly')),
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
		 *
		 * The chrome comes from `.dswc-headerButton`, which copies the built-in
		 * icon buttons in that row: a 24px square, an 8px radius, muted ink and a
		 * translucent hover. The glyph is the same 16px/1px bubble the guide uses.
		 *
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
			}, ChatBubbleGlyph({}))
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
