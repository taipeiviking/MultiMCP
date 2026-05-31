# Google Workspace Manager — Build Spec

> Authoritative spec for implementation. Plan in Claude Chat, build/run in Claude Code.
> Status: SCAFFOLD. Core integration logic is stubbed with `TODO(claude-code)` markers.

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
      "args": ["workspace-mcp", "--tool-tier", "core"],
      "env": {
        "GOOGLE_OAUTH_CLIENT_ID": "<client id>",
        "GOOGLE_OAUTH_CLIENT_SECRET": "<client secret>",
        "GOOGLE_MCP_CREDENTIALS_DIR": "<fixed shared path>",
        "OAUTHLIB_INSECURE_TRANSPORT": "1",
        "WORKSPACE_MCP_TOOLS": "gmail drive calendar"   // limit to the 3 services
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

### b) Transient sign-in server the app launches (per account)
Launch HTTP mode with the same env, drive Google consent for one email, then stop:
```
uvx workspace-mcp --transport streamable-http --tools gmail drive calendar
```
- `OAUTHLIB_INSECURE_TRANSPORT=1` allows the `http://localhost` redirect.
- The redirect URI is `http://localhost:<WORKSPACE_MCP_PORT>/oauth2callback`
  (default port 8000) → must be added to the OAuth client (see §7).
- `TODO(claude-code)`: confirm the exact endpoint/tool to initiate auth for a
  specific account (the server exposes a Google auth start; `start_google_auth`
  tool or the `/authorize` flow). Open the system browser to it, wait for the
  callback, then read back the cached credential file.

## 7. Google Cloud one-time items still required

1. Enable the **standard Google Calendar API** (`calendar-json.googleapis.com`).
2. On the OAuth client (Web application), add redirect URI:
   `http://localhost:8000/oauth2callback`
   (keep the existing `https://claude.ai/api/mcp/auth_callback` too — harmless).
3. Consent screen Audience = External, all 5 emails added as Test users.

## 8. UI (React)

Dark "control room" aesthetic, amber accent, monospace for status/IDs. Screens:
- **Dashboard**: list of account cards (email, connected/expired chip, expiry
  countdown, Re-auth + Remove buttons), a global "Add account" button, and a
  Claude Desktop config status strip (in sync / needs write).
- **Credentials setup**: first-run pane for Client ID + Secret + a "Save securely"
  action; shows where the secret is stored (Windows Credential Manager).
- **Diagnostics**: prerequisite checks (uvx, python), "Test server" with live log.

`TODO(claude-code)`: flesh out components, empty/error/loading states, toasts.

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
- Decision to make: inject the secret into `claude_desktop_config.json` at write
  time (simplest; secret then sits in that file readable by the user) vs. keep it
  only in Credential Manager and have the stdio server read it another way.
  Default: write it into the env block but document the exposure; offer a setting.

## 10. Build / run

- Dev: `npm install`, then `npm run dev` (Vite renderer + Electron).
- Package: `npm run build` then `npm run dist` (electron-builder, Windows NSIS).
- `keytar` is a native module — electron-builder rebuilds it for Electron's ABI.

## 11. Suggested build order for Claude Code

1. Prereq checks + `uvx` detection (serverManager.js).
2. Credentials setup + Credential Manager storage (credentials.js).
3. Claude Desktop config read/merge/write with backup (claudeConfig.js).
4. Single-account sign-in flow end-to-end (serverManager.js + accounts.js).
5. Dashboard status reading from credentials dir (accounts.js).
6. Multi-account, re-auth, remove, expiry countdown.
7. Diagnostics + polish + packaging.
