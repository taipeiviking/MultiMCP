# MultiMCP — Google Workspace Manager

A local Windows desktop control panel that connects **multiple Google Workspace
accounts** to Claude Desktop (Gmail, Drive, Calendar) without hand-editing config
files. It wraps the proven [`workspace-mcp`](https://github.com/taylorwilsdon/google_workspace_mcp)
server — this app handles credentials, per-account sign-in, status, and writing the
Claude Desktop config.

## ⬇️ Download & install

**[➤ Download the latest Windows installer](https://github.com/taipeiviking/MultiMCP/releases/latest)**
— then run **`Google Workspace Manager Setup 0.2.1.exe`**.

1. On the Releases page, under **Assets**, click
   **`Google Workspace Manager Setup 0.2.1.exe`** to download.
2. Run it. If Windows **SmartScreen** shows a one-time *"Windows protected your PC"*
   notice (normal for any app downloaded from the web without a paid code-signing
   certificate), click **More info → Run anyway**. Installs per-user; no admin needed.
3. Make sure [`uv`/`uvx`](https://github.com/astral-sh/uv) is installed (see
   Prerequisites), then launch the app, enter your Google OAuth Client ID + Secret
   once, add each account and **Sign in**, click **Write config**, and restart
   Claude Desktop.

Full step-by-step guide: **[HELP.md](HELP.md)**.

## 🔌 Connecting to Claude Desktop

The whole point of this app is to wire your Google accounts into **Claude Desktop**.
You do that from the app — you never hand-edit Claude's config.

1. **Finish setup in the app first** — enter your Google OAuth **Client ID + Secret**
   once, **Add** each account, and **Sign in** (each opens your system browser; grant
   *all* Gmail/Drive/Calendar scopes). Cards turn 🟢 green when connected.
2. **Click `Write config`.** The app finds Claude Desktop's
   `claude_desktop_config.json`, **backs it up**, and **merges in** a
   `google_workspace` MCP server entry — it writes the absolute path to `uvx` and the
   shared credentials dir, and never touches your other MCP servers. The status strip
   then reads **“Claude Desktop config in sync.”**
3. **Fully quit and reopen Claude Desktop** (tray → Quit, not just close the window —
   Claude only reads its config at startup).
4. In a new chat, open the **connectors / tools** menu — you'll see
   **`google_workspace`** with Gmail, Drive, and Calendar tools. Ask e.g.
   *“search my Gmail for …”* and Claude will use the account(s) you primed.

> **You don't need to keep this app open.** Claude Desktop launches its **own**
> `uvx workspace-mcp` per chat session, pointed at the same shared credentials dir,
> so it reuses the sign-ins you primed here. The tray app exists to do the sign-ins,
> write the config, and warn you before Google's ~7-day token expiry.

**What the entry looks like** (written for you — shown for reference):
```jsonc
// in %APPDATA%\Claude\claude_desktop_config.json
{
  "mcpServers": {
    "google_workspace": {
      "command": "C:\\Users\\you\\.local\\bin\\uvx.exe",
      "args": ["workspace-mcp", "--tools", "gmail", "drive", "calendar"],
      "env": { "GOOGLE_MCP_CREDENTIALS_DIR": "C:\\Users\\you\\.google_workspace_mcp\\credentials", "...": "..." }
    }
  }
}
```

If Claude doesn't show the tools: confirm the strip says **in sync**, then **fully
quit** Claude from its tray icon and reopen. See
[Troubleshooting](HELP.md#troubleshooting) in HELP.md.

## 💻 Use it on a second computer (export / import)

Already set up on one PC and want the same accounts on a laptop? You don't have to
redo Google Cloud or re-sign every account:

1. On the first PC: **Export settings…** (dashboard) → save the `.json`. It carries
   your Client ID + secret, account list, and each account's saved sign-in.
2. Move the file to the other PC, install this app there, then **Import settings…**.
3. Click **Write config** and restart Claude Desktop.

> ⚠️ The export file contains your client secret and live tokens — treat it like a
> password and delete it when done. Details: [HELP.md](HELP.md#export-import).

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
Grab it from the **[latest GitHub Release](https://github.com/taipeiviking/MultiMCP/releases/latest)**
(direct link + SmartScreen note in [Download & install](#️-download--install) above).
The installer creates Start-menu + desktop shortcuts. Launch it, enter your OAuth
Client ID/Secret once, add each account and Sign in, click **Write config**, then
restart Claude Desktop. Tick **Start with Windows** to keep it in the tray on login.

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
