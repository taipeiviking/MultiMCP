# Google Workspace Manager — Build Spec

> Authoritative spec for implementation. Plan in Claude Chat, build/run in Claude Code.
> Status: SHIPPING. Integration complete and verified live end-to-end (Gmail/Drive/
> Calendar through Claude Desktop). Runs as a background tray app with expiry
> notifications and autostart; packages to a Windows NSIS installer. §8 documents the
> UI as built. See HELP.md for the end-user guide.

## 1. Purpose

A local Windows desktop control panel that makes it easy and secure to connect
**multiple Google Workspace accounts** (across different domains) to Claude Desktop
for Gmail, Drive, and Calendar access — without hand-editing config files or
forgetting how anything was set up.

The app does **not** reimplement the MCP server. It is a management/config layer
that wraps the proven, MIT-licensed `workspace-mcp`
(https://github.com/taylorwilsdon/google_workspace_mcp). That server does all the
Google API + MCP work; this app owns credentials, per-account auth, status, and the
Claude Desktop config.

## 2. Non-goals / honest constraints

- **Cannot bypass Google's rules.** While the Google OAuth app is in "Testing"
  status, refresh tokens expire after ~7 days, so each account needs periodic
  re-auth. The app's job is to make re-auth one click and warn before expiry — not
  to eliminate it. Removing the 7-day limit requires publishing the OAuth app and
  passing Google verification (heavy for Gmail/Drive scopes).
- Local only. No telemetry, no cloud, no remote server. Data path is:
  this machine → Google APIs.

## 3. Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Electron app (this project)                             │
│                                                          │
│  React renderer (UI)  ◄── IPC ──►  Electron main process │
│   - Dashboard (5 accounts)            - credentials.js   │
│   - Add / re-auth account             - accounts.js      │
│   - Credentials setup                 - serverManager.js │
│   - Server/diagnostics                - claudeConfig.js   │
└───────────────────────────────┬──────────────────────────┘
                                 │ spawns (for auth + diagnostics)
                                 ▼
                    ┌────────────────────────────┐
                    │ uvx workspace-mcp           │  shared
                    │ (Python, via uv)            │  GOOGLE_MCP_CREDENTIALS_DIR
                    └────────────────────────────┘
                                 │ caches per-account tokens
                                 ▼
            %USERPROFILE%\.google_workspace_mcp\credentials\

Claude Desktop  ── reads ──►  claude_desktop_config.json
        │  (our app writes this entry)
        └── on each session, spawns its OWN stdio `uvx workspace-mcp`
            with the SAME credentials dir → reuses the tokens we primed.
```

### Key insight that makes this coherent
Both (a) the transient server our app launches to perform sign-ins and (b) the stdio
server Claude Desktop launches per session point at the **same** fixed
`GOOGLE_MCP_CREDENTIALS_DIR`. Tokens primed through the app are therefore available
to Claude automatically. There is one token store, one OAuth client, many accounts.

## 4. Responsibilities (what the app actually does)

1. **Credentials setup** — user pastes the Google OAuth Client ID + Secret once.
   Secret is stored in **Windows Credential Manager** (via `keytar`), never in
   plaintext on disk. Client ID (not secret) may live in app settings JSON.
2. **Account management** — add/remove the 5 accounts; for each, run a browser
   OAuth sign-in so a token is cached in the shared credentials dir.
3. **Status dashboard** — for each account show connected / expired and a
   token-expiry countdown, read from the credential files in the credentials dir.
4. **One-click re-auth** — re-run the sign-in for any account (the routine answer
   to the 7-day expiry).
5. **Claude Desktop wiring** — read, merge, and write the `mcpServers` entry in
   `claude_desktop_config.json` so the user never edits JSON by hand. Always merge
   (never clobber other servers) and back up before writing.
6. **Diagnostics** — "Test" button launches the server briefly and surfaces logs;
   prerequisite checks for `uv`/`uvx` and Python.

## 5. Prerequisites the app must check / guide

- **uv / uvx** installed (the app shells out to it). Detect via `where uvx`.
  If missing, show the install command:
  `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`
- **Python 3.10+** (uv can manage this).
- Google Cloud project already set up (done): OAuth client (Web application),
  standard **Gmail API**, **Google Drive API**, and **Google Calendar API** enabled,
  consent screen = **External**, all 5 accounts added as **test users**, and the
  app's local redirect URI present on the OAuth client (see §7).

> NOTE: `workspace-mcp` uses the *standard* Google APIs
> (`gmail.googleapis.com`, `drive.googleapis.com`, `calendar-json.googleapis.com`),
> NOT the `*mcp.googleapis.com` preview APIs. Make sure the **standard Google
> Calendar API** is enabled — that one was not enabled during initial setup.

## 6. workspace-mcp invocation

### a) Claude Desktop config entry the app writes
Target file (Windows): `%APPDATA%\Claude\claude_desktop_config.json`

```jsonc
{
  "mcpServers": {
    "google_workspace": {
      "command": "<absolute path to uvx>",   // resolved via `where uvx`, avoids PATH issues
      "args": ["workspace-mcp", "--tools", "gmail", "drive", "calendar"],
      "env": {
        "GOOGLE_OAUTH_CLIENT_ID": "<client id>",
        "GOOGLE_OAUTH_CLIENT_SECRET": "<client secret>",   // see §9; required for a Web client to refresh
        "GOOGLE_MCP_CREDENTIALS_DIR": "<fixed shared path>",
        "OAUTHLIB_INSECURE_TRANSPORT": "1"
      }
    }
  }
}
```
Notes:
- `command` MUST be an absolute path on Windows; Claude Desktop launches with a
  minimal PATH so bare `uvx` often fails.
- Merge into any existing `mcpServers`; back up the file first.
- The secret is injected at write time from Credential Manager; consider whether to
  keep it out of the on-disk config (tradeoff documented in §9).

### b) Transient sign-in flow the app drives (per account) — CONFIRMED
> Verified against workspace-mcp 1.21.1 source. The earlier streamable-http guess
> was wrong: there is no plain `/authorize` HTTP route. Auth is driven by an MCP
> **tool** over **stdio**.

The app launches the server in **stdio** mode (legacy OAuth 2.0; do NOT set
`MCP_ENABLE_OAUTH21`) and speaks newline-delimited JSON-RPC to it:
```
uvx workspace-mcp --tools gmail drive calendar      # stdio is the default
```
Env: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
`GOOGLE_MCP_CREDENTIALS_DIR`, `OAUTHLIB_INSECURE_TRANSPORT=1`,
`WORKSPACE_MCP_PORT=8000`.

Sequence (implemented in `serverManager.authorizeAccount`):
1. `initialize` (protocolVersion `2024-11-05`) → `notifications/initialized`.
2. `tools/call` **`start_google_auth`** with
   `{ service_name: "Gmail", user_google_email: <email> }`.
3. In stdio + OAuth 2.0 the server: starts a minimal callback server on
   `http://localhost:8000/oauth2callback`, builds the consent URL with
   `login_hint=<email>`, and **opens the system browser automatically**
   (`webbrowser.open`). The tool's text response also contains the URL, which we
   parse and surface as a manual-open fallback.
4. After consent the server writes `<urlencoded-email>.json` into the shared
   credentials dir. The app polls that file's mtime/size for a fresh write, then
   kills the transient server.

The redirect URI `http://localhost:8000/oauth2callback` must be on the OAuth
client (see §7). The same shared credentials dir is read by the stdio server
Claude Desktop launches, so the primed token is immediately usable.

## 7. Google Cloud one-time items still required

1. Enable the **standard Google Calendar API** (`calendar-json.googleapis.com`).
2. On the OAuth client (Web application), add redirect URI:
   `http://localhost:8000/oauth2callback`
   (keep the existing `https://claude.ai/api/mcp/auth_callback` too — harmless).
3. Consent screen Audience = External, all 5 emails added as Test users.

## 8. UI (React) — AS BUILT

Dark "control room" aesthetic, amber accent, monospace for status/IDs.

- **Header**: full-width intro paragraph describing what the app does (the product
  name lives in the OS title bar: "MultiMCP — Google Workspace Manager"). No native
  menu bar — a single **? Help** button (on the Accounts row) opens `HELP.md`.
- **Dashboard**: add-account row; account cards (email, status dot,
  connected/re-auth countdown, **Re-auth** + **Remove**); a Claude Desktop config
  strip ("in sync" shows a green **✓ Done**, otherwise **Write config**); a
  ~7-day-expiry heads-up note; a **Start with Windows** checkbox (default on); a
  Debug-log row with a **View log** button (in-app modal viewer).
- **Credentials**: app-wide editor (toggle at the bottom, "Edit/Hide credentials")
  for the **one** OAuth Client ID + Secret shared by all accounts — explicitly
  labelled so it isn't mistaken for per-account. Secret stored in Credential
  Manager.
- **Bottom status bar**: green/amber dot + "Engine ready" / "Engine missing —
  install uv" (uvx path in tooltip).
- **Window**: size/position persisted in settings.json (DPI-independent).

### Tray / background behavior
- System tray icon; left-click opens the dashboard. Context menu: Open Dashboard,
  per-account status, Re-check now, **Start with Windows** (checkbox), Quit.
- **Close-to-tray**: closing the window hides it; the app keeps running. Only Quit
  exits. Single-instance lock prevents double-running.
- **Autostart**: persisted in settings.json (default on); the OS login item is
  registered only in a packaged build (`--hidden`, launches to tray). Reconciled at
  launch.
- **Expiry watcher**: checks ~8s after launch and every 6h; native notification when
  an account is expired or within 48h of its re-auth deadline; clicking opens the
  dashboard.

### Diagnostics
- Prereq detection (uvx, python) surfaced in the bottom status bar.
- Secret-redacted file logger at `%APPDATA%\google-workspace-manager\logs\app.log`;
  **View log** reads the tail (last 256 KB) into an in-app modal (external editors
  are unreliable on Win11 — the Store Notepad fails to open %APPDATA% paths).

## 9. Security requirements

- Client **secret** → Windows Credential Manager (`keytar` service name
  `google-workspace-manager`, account key `oauth_client_secret`).
- Credentials dir: set restrictive ACLs (current user only). Treat token files as
  secrets; never log them.
- Electron hardening: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true` where possible; expose a minimal, typed API via `preload.js`
  (`contextBridge`). Renderer never touches the filesystem or child processes
  directly — only through IPC.
- Open external URLs (OAuth) in the system browser, not in an Electron window.
- Decision (RESOLVED): the stdio server Claude Desktop launches needs
  `GOOGLE_OAUTH_CLIENT_SECRET` to refresh tokens, and a Python process cannot read
  Windows Credential Manager. For our confidential **Web** OAuth client the secret
  must therefore be injected into `claude_desktop_config.json` (readable by the
  current user). Implemented as a setting `injectSecretIntoConfig` (default
  `true`); setting it `false` omits the secret but breaks refresh for a Web client.
- Credential file format (confirmed, workspace-mcp 1.21.1): one JSON file per
  account named `<urlencoded-email>.json` (plain `<email>.json` for ordinary
  emails) in `GOOGLE_MCP_CREDENTIALS_DIR`, fields `token, refresh_token,
  token_uri, client_id, client_secret, scopes, expiry`. `expiry` is **naive UTC**
  ISO-8601 — parse as UTC. `oauth_states.json` is internal, not an account.

## 10. Build / run

- Dev: `npm install`, then `npm run dev` (Vite renderer + Electron).
- Package: `npm run build` then `npm run dist` (electron-builder, Windows NSIS).
- `keytar` is a native module — electron-builder rebuilds it for Electron's ABI.

## 11. Suggested build order for Claude Code

1. [DONE] Prereq checks + `uvx` detection (serverManager.js).
2. [DONE] Credentials setup + Credential Manager storage + dir ACL lockdown (credentials.js).
3. [DONE] Claude Desktop config read/merge/write with backup (claudeConfig.js).
4. [DONE] Single-account sign-in flow end-to-end via stdio `start_google_auth`
   (serverManager.js + accounts.js). See §6b.
5. [DONE] Dashboard status reading from credentials dir, naive-UTC expiry (accounts.js).
6. [DONE] Multi-account, re-auth, remove, expiry countdown.
7. [PENDING] Diagnostics + polish + packaging (Part D: live E2E + `npm run dist`).

> Code-level `TODO(claude-code)` markers from the scaffold are all resolved. The
> remaining work is the live end-to-end run (needs the Google Cloud items in §7
> done) and producing the installer.
