# MultiMCP — Google Workspace Manager

A local Windows desktop control panel that connects **multiple Google Workspace
accounts** to Claude Desktop (Gmail, Drive, Calendar) without hand-editing config
files. It wraps the proven [`workspace-mcp`](https://github.com/taylorwilsdon/google_workspace_mcp)
server — this app handles credentials, per-account sign-in, status, and writing the
Claude Desktop config.

## ⬇️ Download & install

**[➤ Download the latest Windows installer](https://github.com/taipeiviking/MultiMCP/releases/latest)**
— then run **`Google Workspace Manager Setup 0.1.0.exe`**.

1. On the Releases page, under **Assets**, click
   **`Google Workspace Manager Setup 0.1.0.exe`** to download.
2. Run it. If Windows **SmartScreen** shows a one-time *"Windows protected your PC"*
   notice (normal for any app downloaded from the web without a paid code-signing
   certificate), click **More info → Run anyway**. Installs per-user; no admin needed.
3. Make sure [`uv`/`uvx`](https://github.com/astral-sh/uv) is installed (see
   Prerequisites), then launch the app, enter your Google OAuth Client ID + Secret
   once, add each account and **Sign in**, click **Write config**, and restart
   Claude Desktop.

Full step-by-step guide: **[HELP.md](HELP.md)**.

> **Status: complete and shipping.** Verified live end-to-end against `workspace-mcp`
> (Gmail/Drive/Calendar read for a real account through Claude Desktop), runs as a
> background tray app, and ships as a Windows NSIS installer via
> [GitHub Releases](https://github.com/taipeiviking/MultiMCP/releases). Read
> `SPEC.md` for the authoritative design.

## What it does
- Stores your **one** Google OAuth Client ID/Secret securely (Windows Credential
  Manager). The same client is shared by all accounts — it is not per-account.
- Adds your accounts and runs a one-click **system-browser** sign-in for each.
- Shows per-account status + a re-auth countdown for Google's ~7-day Testing-mode
  token window.
- Writes/merges the `google_workspace` entry into `claude_desktop_config.json`
  (backs up first; never clobbers other MCP servers).
- One-click **Re-auth** (the routine answer to the ~7-day expiry).
- Runs in the **system tray**: closing the window hides it; a periodic check fires
  a native notification before an account goes stale. Optional **Start with
  Windows**. In-app **View log** viewer for diagnostics.

> The tray app does **not** need to be running for Claude to use your accounts —
> Claude Desktop launches its own `uvx workspace-mcp` per session from the shared
> credentials dir. The tray app exists to prime sign-ins and warn before expiry.

## Prerequisites
- Windows 10/11
- [`uv`/`uvx`](https://github.com/astral-sh/uv) on PATH — the app shells out to it.
  Install: `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`
- A Google Cloud project with: OAuth client (Web application), **standard** Gmail,
  Drive, and **Calendar** APIs enabled, consent screen = External, your accounts
  added as Test users, and redirect URI `http://localhost:8000/oauth2callback` on
  the OAuth client. See `SPEC.md` §7 and `HELP.md`.
- Node.js 18+ is only needed to **build** the app, not to run the installed one.

## Install (end users)
Run the installer from `dist/`:
```
Google Workspace Manager Setup 0.1.0.exe
```
It creates Start-menu + desktop shortcuts. Launch it, enter your OAuth Client
ID/Secret once, add each account and Sign in, click **Write config**, then restart
Claude Desktop. Tick **Start with Windows** to keep it in the tray on login.

## Develop
```powershell
npm install
npm run rebuild   # rebuild keytar native module for Electron
npm run dev       # Vite renderer + Electron (hot reload)
```

## Package (Windows installer)
```powershell
npm run dist      # vite build + electron-builder -> NSIS installer in /dist
```
Notes:
- `keytar` is a native module; it ships unpacked from the asar
  (`asarUnpack` in package.json) so it loads at runtime.
- First-ever package on a machine may need an **elevated** shell so electron-builder
  can extract its winCodeSign cache (Windows symlink privilege). Use
  `scripts/dist-build.ps1` from an Administrator PowerShell if `npm run dist` hits
  "A required privilege is not held by the client". Stop any running dev/app
  instance first (it locks `keytar.node`).

## Project layout
```
SPEC.md                     authoritative design (read this first)
HELP.md                     end-user guide (opened by the in-app Help button)
GIT_SETUP.md                git/account/remote notes for this repo
scripts/dist-build.ps1      elevated packaging helper
electron/
  main.js                   main process: IPC, tray, autostart, expiry watcher, window
  preload.js                contextBridge API (typed, minimal)
  assets/                   tray/app icons (+ make-icon.js generator)
  services/
    credentials.js          OAuth secret in Credential Manager (keytar) + settings
    claudeConfig.js         read/merge/write claude_desktop_config.json
    serverManager.js        uvx detection, per-account sign-in (stdio start_google_auth)
    accounts.js             account registry + token/re-auth status
    logger.js               secret-redacted file logger
src/
  App.jsx, components/*      React UI (dashboard, setup, account cards, log viewer)
  styles.css
```

## How it works (one OAuth client, many accounts)
Both the transient sign-in server this app launches and the stdio server Claude
Desktop launches point at the **same** fixed `GOOGLE_MCP_CREDENTIALS_DIR`. Tokens
primed here are therefore available to Claude automatically. There is one token
store, one OAuth client, many accounts. See `SPEC.md` §3 and §6b for the confirmed
`start_google_auth` flow.
