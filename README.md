# dsh-deepseek-webchat

A [DSH](https://github.com/deepseek-ai) sidebar plugin that shows the **real
[chat.deepseek.com](https://chat.deepseek.com/) web app** next to your session,
binds one DeepSeek conversation to each DSH Session, and lets you push selected
messages into the DeepSeek composer as a blockquote — which you then send
yourself.

No API key, no proxy, no scraping. It embeds the actual website through the
desktop shell's native browser guest, the same channel DSH's built-in side-card
browser uses.

- [What it does](#what-it-does)
- [Install](#install)
- [Using it](#using-it)
- [Privacy](#privacy)
- [Known limitations](#known-limitations)
- [How it works](#how-it-works)
- [Development](#development)

## What it does

| | |
|---|---|
| **Real web app** | `chat.deepseek.com` itself, in a sidebar tab. Not an iframe, not the API. |
| **Login persists** | Sign in once; the plugin restores your session on later launches. |
| **One conversation per DSH Session** | Each DSH Session gets its own DeepSeek conversation, remembered by id. |
| **Follows the session you switch to** | Switch DSH Sessions and the sidebar follows to that Session's conversation. |
| **Manual context push** | Tick messages, add a question, preview it, then fill the DeepSeek composer. |
| **You press Enter** | The plugin never sends. Nothing leaves your machine until you submit. |
| **No back-flow** | DeepSeek's answers are never written back into your DSH conversation. |

## Install

Requires DSH Desktop **0.2.0-rc.1 or newer**, and a profile that is already
initialised (the `desktop` profile is created by the app on first run).

```bash
dsh plugin --profile desktop add github:Ckarefulon/dsh-deepseek-webchat
```

Then restart DSH Desktop. The tab appears in the sidebar column's guide, and a
chat icon in the conversation header opens it directly.

`lib/` is committed to this repository on purpose, and there is no `prepare`
script, so the install needs **no build step and no pnpm `allowBuilds`
approval**.

<details>
<summary>Installing from a local clone instead</summary>

```bash
git clone https://github.com/Ckarefulon/dsh-deepseek-webchat
dsh plugin --profile desktop add /absolute/path/to/dsh-deepseek-webchat
```
</details>

<details>
<summary>Uninstalling</summary>

```bash
dsh plugin --profile desktop remove @ckarefulon/dsh-deepseek-webchat
```

Your bindings and saved login live in `~/.dsh/dsh-deepseek-webchat/` and are
left in place; delete that directory to remove them too.
</details>

<details>
<summary>Troubleshooting: DSH will not start after installing</summary>

DSH shows **"The application could not start or stopped unexpectedly"** and
refuses to open. The crash log (the path is shown in the dialog, under
`%APPDATA%\@deepseek-ai\dsh-desktop\logs\`) contains
`client-modules: client bundle not found`.

That means the installed copy's `exports["./client"]` does not point at a real
file. Fix it by reinstalling the plugin from a commit that has the flat layout:

```bash
dsh plugin --profile desktop remove @ckarefulon/dsh-deepseek-webchat
dsh plugin --profile desktop add github:Ckarefulon/dsh-deepseek-webchat
```

To confirm the layout before restarting, from the installed package directory:

```bash
node -e "const p=require('./package.json');const r=p.exports['./client'].default;console.log(r, require('fs').existsSync(r))"
```

It must print `./lib/client.js true`. If it prints `false`, do not restart DSH —
the boot will abort again.

The dialog's *"Disable third-party plugins, back up profile patch, and
restart"* button also works: it starts DSH with third-party plugins unmounted
and saves your profile patch alongside as `cordis.patch.yml.bak-<timestamp>`.
That backup is your configuration, not the plugin, so keep it.
</details>

## Using it

1. **Open the tab.** Click the chat icon in the conversation header, or pick
   「DeepSeek 网页版」 from the sidebar column's guide.
2. **Sign in** to DeepSeek the first time. It is a normal browser login, inside
   the panel.
3. **Send one message** in the DeepSeek page. DeepSeek creates a conversation
   lazily, so this is the moment its id exists — the plugin notices and binds it
   to the current DSH Session. The toolbar dot turns green.
4. **Quote context.** Press 「引用上下文」. Tick the messages you want, optionally
   type a question or instruction, and check the preview.
5. **Press 「填入 DeepSeek 输入框」.** The blockquote lands in DeepSeek's composer
   and the page comes back into view.
6. **Read it over and press Enter yourself.** The plugin stops there.

The toolbar also has 「刷新」 (reload the page) and 「解除绑定」 (forget this
Session's conversation, so the next visit starts a new one).

Switching to a different DSH Session moves the panel to *that* Session's
conversation automatically.

## Privacy

This plugin is built so that **nothing leaves your machine without you pressing
send**, and so that the things you would least want to leak are never even
offered.

**What is sent, and when.** Only the messages you tick, only after you press
「填入 DeepSeek 输入框」 — and even then it is only placed in the composer. It
reaches DeepSeek's servers when *you* press Enter. That is the whole flow: this
plugin has no timer, no auto-send, and no background upload.

**What is never offered.** The picker lists **only** messages you typed and
replies the assistant wrote. The host half filters the session log before it
reaches the picker, dropping:

- `system/message` and `developer/message` events,
- **injected `user/message` events** — agent instructions, skill catalogs, goal
  rounds, time context, compaction checkpoints, team and webhook deliveries,
  which DSH records as user messages but which you never typed. Only events whose
  `source.kind` is `user` are treated as yours,
- tool calls and tool results,
- the model's private reasoning blocks.

So a system prompt, an API key in your environment, or a file the agent read
cannot be quoted by accident.

**What is stored locally.** Two JSON files in `~/.dsh/dsh-deepseek-webchat/`:

- `bindings.json` — the DSH Session id → DeepSeek conversation id map. No message
  content, ever.
- `session.json` — the guest's DeepSeek login state (its site storage and
  non-HttpOnly cookie string), so you stay signed in. This is a **credential**;
  treat the file as you would a browser profile. It is written with the same
  permissions as any other file your user creates.

**No telemetry.** The plugin makes no network request of its own. The only
traffic is the DeepSeek web app talking to DeepSeek, inside its own guest.

**The page runs sandboxed.** The desktop shell approves the guest with
`nodeIntegration: false`, `contextIsolation: true`, `sandbox: true` and
`webSecurity: true`, and refuses every permission request. The page cannot reach
your files or your DSH process.

## Known limitations

These are real, and worth knowing before you rely on the plugin.

**HttpOnly cookies cannot be restored.** The DSH Host runs as a separate Node
child process, not inside Electron, so the plugin cannot reach Electron's cookie
store. It can only read `document.cookie` from inside the guest, and HttpOnly
cookies are invisible there by design. In practice DeepSeek keeps its credential
in `localStorage.userToken` and sends it as a bearer token, so replaying site
storage is what restores your login — but if DeepSeek ever moves its credential
to an HttpOnly cookie, this plugin will start asking you to sign in again after
each restart.

**The guest partition is per-run.** The shell hands out a process-lifetime
session partition and the plugin cannot ask for a different one. Login survival
is therefore the snapshot-and-replay above, not a persistent browser profile.

**One DeepSeek login, shared.** Every DSH Session shares a single DeepSeek
account and browser session; the per-Session split is the conversation, not the
login. Separate DSH Sessions do **not** get separate DeepSeek accounts.

**Binding happens on the first message.** DeepSeek creates a conversation only
when you send something, so a DSH Session stays unbound until you send at least
one message in the page. Until then the toolbar dot is hollow.

**DeepSeek can change its page.** The composer fill targets
`textarea.ds-textarea__textarea`, and the conversation id is read from DeepSeek's
`/a/<agent>/s/<id>` route. If DeepSeek redesigns either, the fill or the binding
stops working until this plugin is updated. The rest of the plugin — embedding,
login, per-Session tabs — is unaffected.

**Desktop only.** The embedded page needs the desktop browser guest channel. In
a plain `dsh web` profile the panel says so instead of falling back to an iframe
(which DeepSeek would refuse anyway, via `frame-ancestors 'none'`).

**One DeepSeek tab per DSH Session.** The tab kind is single-instance, so you
cannot open two DeepSeek panels side by side for the same Session.

## How it works

<details>
<summary>Architecture</summary>

Two halves, as DSH plugins are:

**Host half** (`lib/index.js`, exports `.`) runs in the DSH Host process and
serves five routes under `/api/dsh-deepseek-webchat/`:

| Route | Purpose |
|---|---|
| `state` | What the panel needs to describe itself. |
| `messages?sessionId=` | The Session's quotable messages, filtered. |
| `binding` | Read/write/forget the DSH→DeepSeek conversation map. |
| `session/restore` | Hand back the saved login state. |
| `session/save` | Store the guest's login state. |

It reads messages through `ctx.sessionQuery.readSession()`, which is
live-preferred, and reduces the raw event log with the same text-extraction
rules the harness itself uses.

**Browser half** (`lib/client.js`, exports `./client`) registers the sidebar tab
type, its body, and a header door.

**The guest, and why it is not an iframe.** `chat.deepseek.com` sends
`Content-Security-Policy: frame-ancestors 'none'`, so an `<iframe>` is refused by
the page. Instead the bundle asks `globalThis.dshDesktop.browser.acquire(...)`
for a reservation and attaches a `<webview>` whose `src` is `about:blank#<lease>`
and whose `partition` is the issued one. The shell's `will-attach-webview`
matches the lease, applies hardened preferences, and lets the navigation
through.

**Why the guest lives outside React.** A `<webview>` is destroyed when it leaves
the document, so a slot-owned guest would reload on every tab switch — losing a
half-typed question. The element instead lives in a container the plugin owns at
the document root, and the panel body only measures its area; the guest is
positioned onto that rectangle while the tab shows and hidden when it does not.
The tab type declares `keepMounted: true` so the body survives switches.

**Why the conversation URL works.** DeepSeek's own routes are
`/a/:agentId/s/:sessionId`, and the default agent is `chat`, so a conversation is
addressable as `https://chat.deepseek.com/a/chat/s/<id>` — no in-page JavaScript
is needed to reopen one.
</details>

## Development

Plain JavaScript ESM. No TypeScript, no bundler, no dependencies.

```bash
npm run build   # copy src/ -> lib/
npm test        # node --test
```

`lib/` is a byte-for-byte copy of `src/` and **is committed**, because a
git-hosted plugin must not need a build step on install. `npm test` asserts the
two still match, so they cannot drift.

After editing `src/`, run `npm run build` and commit both trees.

```
src/index.js          host half    -> lib/index.js
src/client/index.js   browser half -> lib/client.js   (note: flat, not lib/client/index.js)
scripts/build.mjs     the copy
test/index.test.js    host: urls, message filtering, bindings, snapshot, mirror
test/routes.test.js   host: every HTTP route, driven through apply()
test/client.test.js   browser: bundle load, registrations, no-auto-send
```

### Why the browser half is `lib/client.js` and not `lib/client/index.js`

This is load-bearing, and getting it wrong makes DSH fail to start at all.

DSH resolves a package's browser half by joining `exports["./client"]` onto the
package root and reading the result as an **exact file path** — there is no
extension and no directory-index fallback. If the manifest says
`./lib/client.js` while the build writes `./lib/client/index.js`, the client
module registry throws `MissingClientBundleError` while the Host is starting,
and because that registry is a *required* plugin the whole boot aborts. The
window shows "The application could not start or stopped unexpectedly" and
names `client-hmr` as waiting on `clientModules`; the crash log reports:

```
client-modules: client bundle not found; run `pnpm run build` before launch:
  package: <name>
  path: .../lib/client.js
```

Every package DSH ships uses the flat `./lib/client.js` form. `npm test` asserts
that every path in `exports` exists and is a regular file, so this cannot
regress.

If you hit that dialog, your installed copy is stale. Reinstall (see
[Install](#install)) after pulling the fixed commit.

## License

MIT. See [LICENSE](LICENSE).

Not affiliated with DeepSeek. "DeepSeek" is a trademark of its owner.
