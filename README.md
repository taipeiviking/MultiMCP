# Google Workspace Manager

A local Windows desktop control panel that connects **multiple Google Workspace
accounts** to Claude Desktop (Gmail, Drive, Calendar) without hand-editing config
files. It wraps the proven [`workspace-mcp`](https://github.com/taylorwilsdon/google_workspace_mcp)
server — this app handles credentials, per-account sign-in, status, and writing the
Claude Desktop config.

> This is a **scaffold**. Integration points marked `TODO(claude-code)` are stubbed
> for completion in Claude Code. Read `SPEC.md` first — it's the authoritative design.

## What it does
- Stores your Google OAuth Client ID/Secret securely (Windows Credential Manager).
- Adds your accounts and runs a one-click browser sign-in for each.
- Shows per-account status + a token-expiry countdown.
- Writes/merges the `google_workspace` entry into `claude_desktop_config.json`.
- Re-auth in one click (the routine answer to Google's ~7-day token expiry).

## Prerequisites
- Windows 11
- Node.js 18+ (to build the app)
- [`uv`/`uvx`](https://github.com/astral-sh/uv) on PATH — the app shells out to it.
  Install: `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`
- A Google Cloud project with: OAuth client (Web application), **standard** Gmail,
  Drive, and **Calendar** APIs enabled, consent screen = External, your accounts
  added as Test users, and redirect URI `http://localhost:8000/oauth2callback` on
  the OAuth client. See `SPEC.md` §7.

## Develop
```powershell
npm install
npm run rebuild   # rebuild keytar native module for Electron
npm run dev       # Vite renderer + Electron
```

## Package (Windows installer)
```powershell
npm run dist      # electron-builder -> NSIS installer in /dist
```

## Project layout
```
SPEC.md                     authoritative design (read this first)
electron/
  main.js                   main process + IPC
  preload.js                contextBridge API
  services/
    credentials.js          OAuth secret in Credential Manager (keytar)
    claudeConfig.js          read/merge/write claude_desktop_config.json
    serverManager.js         uvx detection, per-account sign-in, diagnostics
    accounts.js              account registry + token status
src/
  App.jsx, components/*      React UI (dashboard, setup, account cards)
```

## Where to start in Claude Code
Follow `SPEC.md` §11 build order. The first thing to finalize is the per-account
OAuth sign-in in `serverManager.authorizeAccount()` and the credential-file reader
in `accounts.readTokenStatus()` — both have `TODO(claude-code)` notes pinning down
what to confirm against the live `workspace-mcp`.
