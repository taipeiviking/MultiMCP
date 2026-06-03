# Google Workspace Manager — Help

A local Windows control panel that connects **multiple Google Workspace accounts**
to **Claude Desktop** for Gmail, Drive, and Calendar — without hand-editing config
files. It wraps the open-source [`workspace-mcp`](https://github.com/taylorwilsdon/google_workspace_mcp)
server: this app owns your credentials, per-account sign-in, status, and writing
the Claude Desktop config.

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
- [The ~7-day re-auth and notifications](#the-7-day-re-auth)
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

> **You do not need to keep this app open for Claude to use your accounts.**
> Claude spawns its own server each session. This app exists to (a) do the
> sign-ins, (b) write the Claude config, and (c) **warn you before tokens expire**.

---

<a id="installing"></a>
## Installing (from a GitHub Release)

1. Go to **https://github.com/taipeiviking/MultiMCP/releases/latest**
2. Download **`Google-Workspace-Manager-Setup-0.3.0.exe`**.
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
4. Click **Write config** to wire up Claude Desktop.
5. **Restart Claude Desktop.**

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

---

<a id="adding--signing-in-an-account"></a>
## Adding & signing in an account

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
- **merges** in a `google_workspace` server entry (never clobbering your other MCP
  servers),
- writes the absolute path to the **bundled** `uvx` (Claude launches with a minimal
  PATH, so a bare `uvx` would fail — this is why the engine is bundled and referenced
  by full path).

Then **fully quit and reopen Claude Desktop**. You'll find **google_workspace**
under Connectors / tools.

> **Security note:** for a confidential ("Web") OAuth client, the client **secret**
> is written into `claude_desktop_config.json` so Claude's own server can refresh
> tokens. That file is readable by your Windows user. This is required for a Web
> client — there's no way for Claude's Python process to read Credential Manager.

---

<a id="the-7-day-re-auth"></a>
## The ~7-day re-auth and notifications

While your Google OAuth app is in **"Testing"** status, Google expires refresh
tokens about **every 7 days**. This is a Google policy, not a bug — removing it
requires publishing the app and passing Google's verification (heavy for Gmail/
Drive scopes).

This app's job is to make re-auth **one click** and **warn you before** it
happens: it checks periodically and shows a Windows notification when an account
is expired or within ~48 hours of its re-auth deadline. Click the notification to
open the dashboard, then click **Re-auth**.

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
launch the app to the tray on login. It starts **hidden** (no window pops up).

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

Then click **Write config** and restart Claude Desktop. That's it — no re-auth needed
as long as the tokens are still within their ~7-day window.

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
| 🟢 green dot + "re-auth in Nd Nh" | Connected; token valid, countdown to the 7-day re-auth |
| 🟠 "re-auth needed" / "needs re-auth" | Token expired or missing a refresh token — click **Re-auth** |
| ⚪ grey dot + "not connected" | Account added but never signed in |
| `uvx ready` (green) | `uvx` was found on PATH |
| `uvx missing` (amber) | Install `uv` (see Prerequisites) |
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
  `%APPDATA%\google-workspace-manager\settings.json`.
- **Account list** → `%APPDATA%\google-workspace-manager\accounts.json`.
- **Debug log** → `%APPDATA%\google-workspace-manager\logs\app.log` (secrets and
  tokens are redacted).
- **Electron hardening:** context isolation on, node integration off, sandbox on;
  OAuth always opens in the system browser, never in an app window.

---

<a id="troubleshooting"></a>
## Troubleshooting

**`Engine missing`** — the bundled engine should make this rare. Fully quit the app
(tray → Quit) and relaunch so it re-checks. If you run from source in dev, run
`npm run fetch-uv` once to populate `vendor/uv` (or install system `uv`).

**`redirect_uri_mismatch` in the browser** — the redirect URI on your OAuth client
must be exactly `http://localhost:8000/oauth2callback`. Newly added URIs can take a
few minutes to propagate.

**`access_denied` / "app not verified"** — make sure the account is added as a
**Test user** on the consent screen, and click **Advanced → Go to … (unsafe)**.

**Account won't go green after sign-in** — finish consent fully in the browser
(grant *all* scopes), then click **Re-auth** again or **Re-check now** in the tray.

**Claude can't see the tools** — confirm the config is **in sync**, then **fully
quit** Claude Desktop (tray → Quit) and reopen. Check Claude's own logs at
`%APPDATA%\Claude\logs\`.

**Port 8000 in use** — another process is using the OAuth callback port. Close it
and retry the sign-in.

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
- the `google_workspace` block from `%APPDATA%\Claude\claude_desktop_config.json`

---

*Built to wrap [`workspace-mcp`](https://github.com/taylorwilsdon/google_workspace_mcp).
Local-only, least-privilege (`--tools gmail drive calendar`).*
