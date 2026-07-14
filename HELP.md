# Google Workspace Manager — Help

A local Windows control panel that connects **multiple Google Workspace accounts**
to **Claude Desktop** and **OpenAI Codex** for Gmail, Drive, and Calendar — without
hand-editing config files. It wraps the open-source [`workspace-mcp`](https://github.com/taylorwilsdon/google_workspace_mcp)
server: this app owns your credentials, per-account sign-in, status, and writing
the config files those clients read.

> **Everything stays on your machine.** No telemetry, no cloud, no remote server.
> Your data path is: this PC → Google's APIs. The OAuth client secret is stored in
> **Windows Credential Manager**, and per-account tokens live in a local,
> ACL-restricted folder.

---

## Contents
- [Installing (from a GitHub Release)](#installing)
- [How it works (the big picture)](#how-it-works)
- [First-time setup](#first-time-setup)
- [Prerequisites](#prerequisites)
- [Google Cloud setup](#google-cloud-setup)
- [Adding & signing in an account](#adding--signing-in-an-account)
- [Writing the Claude Desktop config](#writing-the-claude-desktop-config)
- [Using it from OpenAI Codex](#codex)
- [The ~7-day re-auth and notifications](#the-7-day-re-auth)
- [Make sign-ins long-lived (stop the 7-day re-auth)](#long-lived)
- [The tray icon & background mode](#tray--background)
- [Start with Windows](#start-with-windows)
- [Moving to another computer (export / import)](#export-import)
- [Status indicators](#status-indicators)
- [Security & where things are stored](#security--storage)
- [Troubleshooting](#troubleshooting)
- [Uninstalling](#uninstalling)

---

<a id="how-it-works"></a>
## How it works (the big picture)

There is **one OAuth client**, **one shared credentials folder**, and **many
accounts**. When you sign an account in, this app launches a short-lived
`workspace-mcp` process that drives Google's consent screen in your **system
browser** and caches that account's token in the shared folder.

Claude Desktop, in turn, launches its **own** `workspace-mcp` per chat session,
pointed at the **same** shared folder — so it automatically reuses the tokens you
primed here. That's the whole trick.

**OpenAI Codex works exactly the same way.** Since v0.5.0 the app can also write a
Codex config entry, pointed at that same shared folder. Codex therefore reuses the
identical sign-ins — there is nothing to authorize a second time. See
[Using it from OpenAI Codex](#codex).

> **You do not need to keep this app open for Claude or Codex to use your accounts.**
> Each client spawns its own server. This app exists to (a) do the sign-ins,
> (b) write the client configs, and (c) **warn you before tokens expire**.

---

<a id="installing"></a>
## Installing (from a GitHub Release)

1. Go to **https://github.com/taipeiviking/MultiMCP/releases/latest**
2. Under **Assets**, download the installer **`Google-Workspace-Manager-Setup-<version>.exe`**
   (the `<version>` is whatever the latest release happens to be — that page always
   shows the newest one).
3. Run it. Because the file was **downloaded from the internet**, Windows
   **SmartScreen** may show a one-time *"Windows protected your PC"* notice (this
   happens for any app without a paid code-signing certificate, signed or not).
   Click **More info → Run anyway**. It installs per-user; no admin needed.
4. The installer creates Start-menu + desktop shortcuts.

> Why the notice? Windows flags files downloaded from the web ("Mark of the Web").
> A paid CA code-signing certificate would remove the prompt, but isn't required —
> the app is open-source, so you can also clone the repo and run
> `npm install && npm run dist` to build the identical installer yourself (a
> locally-built installer carries no web mark and shows no notice).

<a id="first-time-setup"></a>
## First-time setup

1. **No engine install needed** — the `uv`/`uvx` engine is **bundled with the app**.
   The footer shows **"Engine ready (bundled)"**. (If you already have `uv`, the app
   prefers its bundled copy. On first run, uv auto-provisions Python + `workspace-mcp`.)
2. **Enter your Google OAuth Client ID + Secret** (Credentials screen). The secret
   goes into Windows Credential Manager; the Client ID into local settings.
3. **Add each account** and click **Sign in** — complete consent in the browser.
4. Click **Write config** to wire up Claude Desktop. If you use OpenAI Codex, also click
   **Write Codex config** — see [Using it from OpenAI Codex](#codex).
5. **Restart Claude Desktop** (and Codex, if you configured it).

---

<a id="prerequisites"></a>
## Prerequisites

- **Windows 10/11.**
- **The `uv` / `uvx` engine is bundled** with the installer — you do **not** need to
  install it separately. The footer shows **"Engine ready (bundled)"**.
  - If you'd rather use your own system `uv`, install it and the app will still work
    (it prefers the bundled copy). Install: `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`
- **Python** — `uv` provisions this automatically on first run; nothing to install.

---

<a id="google-cloud-setup"></a>
## Google Cloud setup

In the [Google Cloud Console](https://console.cloud.google.com/):

1. **Enable APIs** (the *standard* ones, not the `*mcp.googleapis.com` previews):
   - Gmail API
   - Google Drive API
   - **Google Calendar API** (`calendar-json.googleapis.com`)
2. **OAuth consent screen:** User type / Audience = **External**.
   - Add **every** account you'll connect as a **Test user** (Testing mode allows
     up to 100 test users).
3. **OAuth client (Web application):** add the redirect URI **exactly**:
   ```
   http://localhost:8000/oauth2callback
   ```
   (Keep any existing URIs too.)

> If a Workspace account isn't on the Test users list, its sign-in will be blocked
> at Google's consent screen.

> **Don't add a redirect URI for port 9000 or 9001.** Port 8000 is the app's sign-in, and
> it is the only one that needs registering. Port 9000 belongs to the server Claude runs in
> the background, and port 9001 to the one Codex runs; leaving both unregistered is
> deliberate: it means a background process can never quietly complete a Google sign-in —
> possibly for the wrong account — behind your back. Signing in is always something you do
> yourself, in the app.

---

<a id="adding--signing-in-an-account"></a>
## Adding & signing in an account

> 📖 Prefer a fuller, illustrated walkthrough (including how to get out of Testing mode
> for long-lived sign-ins)? See **[docs/ADD_ACCOUNT.md](docs/ADD_ACCOUNT.md)**.

1. Type the email in the **add account** box and click **Add**. A grey
   *not connected* card appears.
2. Click **Sign in**. Your **system browser** opens automatically to Google.
3. You'll likely see **"Google hasn't verified this app"** — this is normal for an
   app in Testing. Click **Advanced → Go to … (unsafe)**. It's your own app.
4. Confirm the right account (it's pre-selected), and **grant all** Gmail / Drive /
   Calendar permissions. *Partial grants cause "missing scopes" errors later.*
5. The browser shows **"Authentication Successful."** Return to the app — the card
   turns **green** with a re-auth countdown.

**Re-auth** repeats this for an existing account (the routine fix when a token
ages out). **Remove** forgets the account in the app (it does **not** delete the
cached token file).

---

<a id="writing-the-claude-desktop-config"></a>
## Writing the Claude Desktop config

Click **Write config** in the status strip. The app:
- backs up your existing `claude_desktop_config.json` first,
- **merges** in a **`MultiMCP`** server entry (never clobbering your other MCP
  servers),
- writes the absolute path to the **bundled** `uvx` (Claude launches with a minimal
  PATH, so a bare `uvx` would fail — this is why the engine is bundled and referenced
  by full path).

Then **fully quit and reopen Claude Desktop**. You'll find **MultiMCP** under
Connectors / tools.

> **The connector was renamed in v0.4.0.** It used to appear in Claude as
> **`google_workspace`**; it is now **`MultiMCP`**. The name Claude shows is simply
> the key used in `claude_desktop_config.json`, so renaming it is just a config
> change. The app **deletes the old `google_workspace` entry** when it writes the new
> one — automatically, on launch — so you won't end up with two connectors listed.

> **The app also repairs the entry when it drifts.** On launch it re-checks the
> settings the connector depends on (and re-adds the whole entry if something else,
> such as a Claude Desktop reinstall, replaced the config file and dropped it). That
> is how fixes like the one in v0.4.0 reach a PC that was already set up.

> **Security note:** for a confidential ("Web") OAuth client, the client **secret**
> is written into `claude_desktop_config.json` so Claude's own server can refresh
> tokens. That file is readable by your Windows user. This is required for a Web
> client — there's no way for Claude's Python process to read Credential Manager.

---

<a id="codex"></a>
## Using it from OpenAI Codex

**New in v0.5.0.** The same accounts, the same sign-ins, now available in OpenAI
Codex as well.

On the dashboard, just below the Claude **Write config** row, there is a Codex row.
Click **Write Codex config**. That single click merges an `[mcp_servers.MultiMCP]`
table (and its `[mcp_servers.MultiMCP.env]` sub-table) into your Codex configuration
file at `~/.codex/config.toml` — or `$CODEX_HOME/config.toml`, if you've set that
variable. Then restart Codex.

(If Codex isn't installed on this PC, that row simply says so — there is no button to
press and nothing you need to do.)

**You do not sign anything in again.** Codex is pointed at the *same* credentials
folder as Claude, so it reuses the exact same token files. Every account that is
green in this app is immediately usable from Codex.

In Codex, the tools appear with a prefix — `mcp__MultiMCP__search_gmail_messages`,
and so on.

### Which OpenAI products this actually works with

This is the part people get wrong, so it's worth being precise:

| Product | Works? |
|---|---|
| **Codex CLI** | ✅ Yes |
| **Codex IDE extension** | ✅ Yes |
| **Codex inside the ChatGPT desktop app** | ✅ Yes |
| **Ordinary ChatGPT conversations** (chatgpt.com, or the chat side of the desktop app) | ❌ No |

The three that work are all *Codex*, and they all read the same
`~/.codex/config.toml` — so one **Write Codex config** click sets up all of them.

Ordinary ChatGPT chats cannot use this connector at all. ChatGPT supports only
**remote** MCP servers (SSE / streamable HTTP), reached over the network. MultiMCP
is a **local (stdio)** server that runs on your PC. That's a limitation of ChatGPT,
not something this app can switch on.

### Verifying it landed

Codex's command-line tool is **not on your `PATH`**. It ships inside the desktop app,
at a version-hashed path that changes whenever Codex updates:

```
%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe
```

Run it from there (or from a terminal opened by the Codex IDE extension), and ask
Codex what it thinks the server's settings are:

```
codex mcp get MultiMCP
```

You should see, among other things:

```
startup_timeout_sec: 120
tool_timeout_sec: 300
```

**Do this check at least once.** Codex **silently discards config keys it doesn't
recognise** — a misspelling isn't an error, it's simply ignored, and the server then
runs with Codex's much shorter defaults. `codex mcp get` is the only way to prove the
settings actually took effect.

### The first tool call is slow — that's expected

The **first** time Codex calls a MultiMCP tool, it can take up to about **two
minutes** while `uvx` warms up and provisions the server. This is not a hang. That
is exactly why the app sets `startup_timeout_sec = 120` (Codex's own default of 10
seconds would kill the server mid-start) and `tool_timeout_sec = 300` (a large Gmail
batch fetch can outrun the 60-second default). Subsequent calls are fast.

### Codex never opens browser tabs either

Codex's server gets the same two protections as Claude's: the setting that fixed the
v0.4.0 sign-in tabs (it is named "single-user mode", but despite the name it does
**not** limit you to one account — all of your accounts keep working), and a
do-nothing stand-in for the browser, so it is **physically unable** to open a Google
sign-in tab. Codex deliberately wipes the environment before launching an MCP server,
so the app passes every variable it needs explicitly — the browser stand-in above all,
since an *unset* browser setting would send Python straight to your real browser.

Codex also gets its **own port, 9001** (Claude's server uses 9000; your sign-ins in
this app use 8000). Like 9000, port 9001 is **not** registered with Google on purpose —
a safety interlock, so a background sign-in can never complete. Don't register it.

### How your `config.toml` is treated

`config.toml` is a file you edit *and* the Codex app edits (Codex re-adds its own
built-in `node_repl` server on every launch). It also holds your model choice,
plugins, project trust levels and any other MCP servers. So the app never rewrites
it. It replaces **only its own `MultiMCP` table**, preserving every other byte,
comments included: it validates the result in memory *before* touching the disk,
takes a timestamped backup, writes atomically, then re-reads and re-validates —
restoring the backup if anything looks wrong. If it meets a file shape it cannot edit
safely, it **refuses and tells you**, rather than guessing.

> **Security note (same trade-off as Claude):** the OAuth client **secret** is written
> into `config.toml`, because the local server needs it to refresh tokens. The file is
> readable by your Windows user. This is documented in SPEC section 9.

### Removing it

Open `~/.codex/config.toml` in a text editor and delete the block the app added. It is
easy to spot: the app writes a marker comment above it (`# >>> MultiMCP (managed by
Google Workspace Manager) …`), and the block itself is the `[mcp_servers.MultiMCP]`
table together with its `[mcp_servers.MultiMCP.env]` sub-table. Leave the rest of the
file alone. Your accounts, your tokens and your Claude setup are not affected.

> **One catch:** once you have clicked **Write Codex config**, the app treats that
> entry as its own and **puts it back if it goes missing** — the same self-repair that
> restores Claude's entry after a Claude Desktop reinstall. So it will reappear the
> next time the tray app starts. Deleting it for good therefore means deleting it
> *after* you have uninstalled the app (see [Uninstalling](#uninstalling)), or simply leaving
> the entry in place — an MCP server Codex never calls costs you nothing.

### Known limitation: Claude and Codex share one credentials folder

Sharing the tokens is what makes "no second sign-in" possible, but it has a cost.
`workspace-mcp` writes its token files **non-atomically** (no lock: it truncates, then
writes). If Claude and Codex happen to refresh the **same account** at the **same
instant**, that account's token file can be corrupted, and the account will need
signing in again.

The window is narrow — but it is real, and running both clients is exactly what makes
it reachable. See [Troubleshooting](#troubleshooting) for what it looks like and the
one-click fix.

---

<a id="the-7-day-re-auth"></a>
## The ~7-day re-auth and notifications

While your Google OAuth app is in **"Testing"** status, Google expires refresh
tokens about **every 7 days**. This is a Google policy, not a bug — removing it
requires publishing the app (see [Make sign-ins long-lived](#long-lived) below).

**The app verifies each account live against Google** — a real token refresh on
launch, every 6 hours, and whenever you click **Check now** (top-right of the
Accounts screen). So the status reflects reality, not a fixed countdown:

- **connected ✓ · verified Xm ago** — the token is confirmed working right now.
- **re-auth needed** — Google actually rejected the saved sign-in; click **Re-auth**.

In **Testing** mode the card also shows the ~7-day countdown as a heads-up, and the
app fires a Windows notification when an account is expired or within ~48 hours of
its deadline (click it to open the dashboard, then **Re-auth**). Once you're in
**Production** (next section) the countdown disappears — the app simply keeps
verifying and warns you only if a sign-in genuinely fails.

---

<a id="long-lived"></a>
## Make sign-ins long-lived (stop the 7-day re-auth)

The ~7-day expiry is **only** because your Google OAuth app is in **"Testing"**.
Switching it to **"In production"** removes the weekly refresh-token expiry — this
is a **Google Cloud Console setting, not an app setting**, and it's free and instant.

### Step 1 — Publish the app to production
In the [Google Cloud Console](https://console.cloud.google.com/) with your project
(e.g. *Claude Connector*) selected:

1. Go to **APIs & Services → OAuth consent screen** (in the newer console this is
   **Google Auth Platform → Audience**).
2. Under **Publishing status** you'll see **Testing**. Click **Publish app**, then
   confirm **Push to production**.
3. The status changes to **In production**. That's it — the 7-day clock is off.

### Step 2 — Re-auth each account once
Tokens already issued *under Testing* keep their 7-day expiry; publishing doesn't
fix them retroactively. So after publishing, click **Re-auth** on each account in
the app **once**. The token minted *after* publishing is the long-lived one.

### Step 3 — Tell the app you're in production
On the dashboard, tick **"OAuth app published to production (no 7-day token
expiry)"**. This hides the 7-day countdown immediately and switches every card to
the live **"connected ✓ · verified …"** status. (If you forget, the app
**auto-detects** production anyway once a token keeps working past 7 days, and ticks
the box for you.) You can press **Check now** at any time to re-verify every account
on the spot.

### What this does NOT change
- **You'll still see "Google hasn't verified this app"** at sign-in (the
  *Advanced → Go to … (unsafe)* screen). That's expected for an unverified app and
  is harmless — it's your own app. Removing **that** warning requires full **Google
  verification** (verified domain, privacy-policy + homepage URLs, app logo, and —
  because Gmail/Drive are *restricted* scopes — an **annual third-party CASA
  security assessment**). That's heavy and usually unnecessary for personal/team use.

### Tokens can still expire (rare)
Even in production a refresh token is invalidated if: the account **password
changes**, the user **revokes access** (myaccount.google.com → Security → Third-party
access), the token is **unused for 6 months**, or you exceed Google's per-user token
limit. These are occasional, not the weekly grind of Testing mode.

> **TL;DR:** Console → OAuth consent screen → **Publish app** → then **Re-auth** each
> account once. No more weekly re-auth. The "unverified app" click-through stays
> unless you complete Google verification.

---

<a id="tray--background"></a>
## The tray icon & background mode

- The app lives in your **system tray** (the amber dot — click the `^` chevron if
  hidden).
- **Closing the window hides it to the tray**; the app keeps running so it can
  watch for expiry. Use **Quit** in the tray menu to fully exit.
- **Right-click the tray icon** for: Open Dashboard · per-account status ·
  **Re-check now** · **Start with Windows** · Quit.

---

<a id="start-with-windows"></a>
## Start with Windows

Toggle **Start automatically with Windows** (dashboard footer or tray menu) to
launch the app to the tray on login. It starts **hidden** — **no window pops up**,
so look in the system tray (click the `^` chevron to show hidden icons) for the
amber dot. "No window" does **not** mean it failed to start.

**How it's registered:** the app creates a Task Scheduler **"At log on"** task
(`GoogleWorkspaceManagerAutostart`, per-user, no admin needed) *and* an
`HKCU\…\Run` value as a fallback. The scheduled task is used because plain Run-key
entries can be **silently skipped after a Windows "Fast Startup" (hybrid shutdown)
resume** — which is the usual reason a tray app "doesn't come back after reboot."

> If it ever doesn't start after a boot: open it once from the Start menu (that
> re-reconciles the task), or toggle **Start automatically with Windows** off and
> on. You can also confirm the task exists with
> `Get-ScheduledTask GoogleWorkspaceManagerAutostart` in PowerShell.

> This only takes effect in the **installed** app. In a development build the
> setting is remembered but not registered, because a dev login item would point
> at the raw Electron binary rather than the installed app.

---

<a id="export-import"></a>
## Moving to another computer (export / import)

Want the same multi-account setup on a second PC (e.g. a laptop)? You don't have to
redo Google Cloud or sign every account in again — **export** your setup here and
**import** it there.

**On the first computer:** dashboard → **Export settings…** → choose where to save
the `.json`. The file contains, in one place:
- your **Client ID** and (from Credential Manager) the **client secret**,
- your **account list**, and
- each account's **saved sign-in** (the refresh token workspace-mcp uses).

**Move the file** to the other computer (USB stick, private cloud folder, etc.).

**On the second computer:** install and launch this app. On the very first screen
(*"Connect your Google OAuth client"*) click **Import settings from a file…** — you do
**not** need to type the Client ID/Secret first; the import brings those too. (After
setup, the same control is on the dashboard.) Pick the file, review the summary, and
choose:
- **Import (keep existing)** — adds accounts/sign-ins that aren't already there;
  leaves any sign-ins already on this PC untouched. *(Recommended.)*
- **Import & overwrite** — also replaces existing token files with the ones from the
  backup (use if the backup is newer/authoritative).

Then click **Write config** and restart Claude Desktop — plus **Write Codex config** if you
use [Codex](#codex) on this machine, unless that row already reads **✓ Done**. That's it — no
re-auth needed, as
long as the sign-ins in the file are still valid. (If your OAuth app is still in
**Testing**, those sign-ins expire after ~7 days, so an older export may need a re-auth or
two; once it's [published to production](#long-lived), they keep working.)

> ⚠️ **Treat the export file like a password.** It carries your client secret and
> live refresh tokens — anyone with the file can act as those accounts. It's written
> with restrictive permissions; store it somewhere private and delete it when done.
> The app keeps **this** computer's own credentials-folder path on import (paths
> differ per machine), so nothing local is broken by importing.

---

<a id="status-indicators"></a>
## Status indicators

| Indicator | Meaning |
|---|---|
| 🟢 green dot + "connected ✓ · verified Xm ago" | Live-verified against Google just now — the token works |
| 🟢 green dot + "re-auth in Nd Nh · Testing mode" | Connected; Testing-mode 7-day countdown (shown until verified or you enable production) |
| 🟠 "re-auth needed" | Google rejected the saved sign-in, or it expired — click **Re-auth** |
| 🟠 "needs re-auth (no refresh token)" | The cached sign-in has no refresh token — click **Re-auth** |
| ⚪ grey dot + "not connected" | Account added but never signed in |
| `Engine ready (bundled)` (green) | the bundled `uvx` engine runs |
| `Engine missing` (amber) | Install `uv` (see Prerequisites) |
| Claude config **in sync** / **out of date** / **not written** | State of your `claude_desktop_config.json` |

---

<a id="security--storage"></a>
## Security & where things are stored

- **OAuth client secret** → Windows Credential Manager (service
  `google-workspace-manager`, key `oauth_client_secret`). Never written to disk in
  plaintext by this app (exception: injected into the Claude config — see above).
- **Per-account tokens** → `%USERPROFILE%\.google_workspace_mcp\credentials\`,
  one `<email>.json` per account. The folder is ACL-locked to your user on first
  setup.
- **App settings** (Client ID, credentials-dir path, autostart pref) →
  `%APPDATA%\google-workspace-manager\settings.json`, with a rolling backup alongside it
  (`settings.json.bak`). Since v0.3.9 this file is written **atomically**, so a crash or an
  unclean shutdown can't leave it half-written; if it is ever found damaged, the app
  restores it from the backup automatically.
- **Account list** → `%APPDATA%\google-workspace-manager\accounts.json`.
- **Debug log** → `%APPDATA%\google-workspace-manager\logs\app.log` (secrets and
  tokens are redacted).
- **Electron hardening:** context isolation on, node integration off, sandbox on;
  OAuth always opens in the system browser, never in an app window — and only when *you*
  start a sign-in from the app. The background servers — Claude's and Codex's alike — are
  deliberately given no way to open a browser at all (a small do-nothing stand-in under
  `%LOCALAPPDATA%\MultiMCP\`), which is why they can no longer surprise you with sign-in tabs.

---

<a id="troubleshooting"></a>
## Troubleshooting

**Claude opens Google sign-in tabs saying "Access blocked" / "Error 400: redirect_uri_mismatch"**
— this was a bug, and it is **fixed in v0.4.0**. Update to the latest release, then
**fully quit and reopen Claude Desktop** — the fix lives in the connector entry that
the app rewrites on launch, and a Claude that is still running will keep using the
old one until it is properly restarted (tray → Quit, not just closing the window).

What you were seeing: as soon as a single Claude conversation touched a **second**
account, a browser tab opened for it — one tab per extra account — each landing on
Google's *"Access blocked: this app's request is invalid — Error 400:
redirect_uri_mismatch"* page. Because it was triggered by **using more than one
account**, which is the entire point of this app, it fired in practically every real
session. Whichever account you happened to use first worked fine; every later one
produced a tab.

The cause was in the underlying `workspace-mcp` server, not in your Google setup and
**not** an expired sign-in: the server locked its session to the first account whose
token it refreshed, and then wrongly reported every *other* account as "not signed
in" — even though those accounts' tokens had just refreshed successfully. Believing
you were signed out, it tried to send you to Google to sign in again.

The fix tells the server to look each account up by the email address the request was
actually for, instead of binding the whole session to one of them. **All of your
accounts keep working exactly as before** — nothing is limited to a single account.

As a second line of defence, Claude's background server is now started in a way that
makes it **physically unable to open a browser tab at all**, so even a genuinely dead
sign-in can no longer surprise you with one. See the next entry for what happens
instead.

**An account genuinely needs signing in again** — you will **not** get a browser tab
from Claude. Instead the tray app checks whether the sign-in really is dead, and if it
is, raises a **Windows notification**. Open the dashboard, find the account showing
**re-auth needed**, and click **Re-auth** — that sign-in opens a real browser window,
from the app, which is exactly where it belongs (it's the only place you can see which
account you're approving).

**`Engine missing`** — the bundled engine should make this rare. Fully quit the app
(tray → Quit) and relaunch so it re-checks. If you run from source in dev, run
`npm run fetch-uv` once to populate `vendor/uv` (or install system `uv`).

**`redirect_uri_mismatch` while signing in *from the app*** — this is the different,
ordinary case: the redirect URI on your OAuth client must be exactly
`http://localhost:8000/oauth2callback`. Newly added URIs can take a few minutes to
propagate. (If the tab came from **Claude** rather than from clicking **Sign in** or
**Re-auth** in the app, see the first entry above instead.)

**`access_denied` / "app not verified"** — make sure the account is added as a
**Test user** on the consent screen, and click **Advanced → Go to … (unsafe)**.

**Account won't go green after sign-in** — finish consent fully in the browser
(grant *all* scopes), then click **Re-auth** again or **Re-check now** in the tray.

**Claude can't see the tools** — confirm the config is **in sync**, then **fully
quit** Claude Desktop (tray → Quit) and reopen. Check Claude's own logs at
`%APPDATA%\Claude\logs\`.

**"Could not attach to MCP server MultiMCP"** — a cold-start timeout: the first
time a new `workspace-mcp` version runs, `uvx` installs it (~90 packages), which can
exceed Claude's attach timeout. The tray app **pre-warms** this in the background (on
launch + every 6h), so keep it running. If you still see it, **reopen Claude once
more** — the first (failed) attach finishes the install, so the next attach is fast.
(On versions before v0.4.0 the connector was called `google_workspace`, so the same
message named that instead.)

**"MCP MultiMCP: Server disconnected"** — usually **not** a real failure. Claude
shows this when a server it previously had is no longer connected — e.g. after the PC
slept, or after Claude was quit/updated. The server re-spawns fine on the next request
(check the connectors menu — the tools are still there). If it's **persistent**, the most
common cause is running the **Microsoft Store** build of Claude Desktop: its sandboxing is
less reliable for long-lived local (stdio) MCP servers. Installing the regular **installer**
build from <https://claude.ai/download> (and uninstalling the Store one, so two Claudes
don't both spawn a server on port 9000) typically resolves it. Both builds read the same
config at `%APPDATA%\Claude`, so nothing to reconfigure — just **Write config** again and
fully **quit + reopen** Claude. **Step-by-step:** [docs/SWITCH_CLAUDE_BUILD.md](docs/SWITCH_CLAUDE_BUILD.md).
Ref: [MCP debugging guide](https://modelcontextprotocol.io/docs/tools/debugging).

**Codex says the server failed to start** — this is the same cold-start problem: the
first time a new `workspace-mcp` version runs, `uvx` has to install it (~90 packages),
and until that finishes the server has nothing to answer with. The app already sets
`startup_timeout_sec = 120` for Codex precisely for this, so first confirm the setting
really landed — run `codex mcp get MultiMCP` and check it says `startup_timeout_sec: 120`
(Codex silently ignores keys it doesn't understand, so this is the only reliable proof).
If it's there, the fix is simply to let the install finish: leave the tray app running so
it can **pre-warm** the engine in the background (it does this on launch and every 6
hours), then **try again**. The failed attempt itself completes the install, so the next
attempt is usually fine. Remember, too, that a healthy first tool call can still take up
to ~2 minutes — that's the warm-up, not a failure.

**I use Claude and Codex at the same time** — that's supported, and both share the same
sign-ins. There is one rough edge to know about. The two clients share **one credentials
folder**, and `workspace-mcp` writes token files without locking them. If both clients
refresh the **same account** at the **same moment**, they can collide and leave that
account's token file damaged.

What it looks like: **one** account (not all of them) suddenly goes **re-auth needed**,
even though you did nothing and nothing expired — while your other accounts carry on
working normally. The fix is exactly what it sounds like: open the dashboard and click
**Re-auth** on that one account. Nothing else needs repairing, and no other account is
affected.

**The "Connect your Google OAuth client" screen appears even though you're set up** —
**fixed in v0.3.9.** The real cause turned out to be worse than the timing race that
v0.3.8 had guessed at: restarting the PC could leave `settings.json` truncated, and the
app, unable to read it, would then quietly save an empty file back over it — erasing
your Client ID for good. Settings are now written **atomically** and kept with a rolling
backup, so an unclean shutdown can no longer damage the file; a damaged file is restored
from the backup automatically, and if the app cannot read the file at all it now
**refuses to overwrite it** rather than making things worse.

If a settings file was already destroyed by an older version, the first-run screen now
says so — *"Your settings appear to have been lost"* — instead of greeting you as a new
user, and points you at **Import settings from a file…**, which restores everything from
your last exported backup. (This is the reason to keep an export somewhere safe; see
[Moving to another computer](#export-import).)

Separately, **reinstalling Claude Desktop** replaces `claude_desktop_config.json` and
used to silently drop the connector. Since v0.3.9 the app puts its entry back on launch
on any PC where it wrote one before.

**Port 8000 in use** — another process is using the OAuth callback port. Close it
and retry the sign-in. (Sign-ins you start **in the app** use port **8000** — that is
the only redirect URI registered on the OAuth client. Claude's background server is
pinned to **9000** and Codex's to **9001**, so they never clash with it or with each
other. Those servers do still refresh tokens by themselves — that's normal and needs no
browser — but they deliberately have **no** registered redirect URI on 9000 or 9001 and
no way to open a browser, so they can never complete a Google consent screen on their
own. Signing in is always something you do, visibly, from the app.)

**Reveal log** opens `%APPDATA%\google-workspace-manager\logs\`. Attach `app.log`
when reporting an issue (it's secret-redacted).

---

<a id="uninstalling"></a>
## Uninstalling

Uninstall from Windows **Settings → Apps**. To fully remove all data, also delete:
- `%APPDATA%\google-workspace-manager\`
- `%USERPROFILE%\.google_workspace_mcp\`
- the `oauth_client_secret` entry under `google-workspace-manager` in
  Windows Credential Manager
- the `MultiMCP` block from `%APPDATA%\Claude\claude_desktop_config.json` (if the app
  was last written by a version before v0.4.0, that block is called `google_workspace`)
- the Codex entry, if you added one — the `[mcp_servers.MultiMCP]` table and its
  `[mcp_servers.MultiMCP.env]` sub-table in `~/.codex/config.toml`, along with the
  `# >>> MultiMCP …` marker comment above them (leave the rest of the file as it is)

---

*Built to wrap [`workspace-mcp`](https://github.com/taylorwilsdon/google_workspace_mcp).
Local-only, least-privilege (`--tools gmail drive calendar`).*
