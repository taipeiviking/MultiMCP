# Google Workspace Manager — Build Spec

> Authoritative spec for implementation. Plan in Claude Chat, build/run in Claude Code.
> Status: SHIPPING. Integration complete and verified live end-to-end (Gmail/Drive/
> Calendar through Claude Desktop). Runs as a background tray app with expiry
> notifications and autostart; packages to a Windows NSIS installer. §8 documents the
> UI as built. See HELP.md for the end-user guide.
>
> **Current: v0.4.0.** Recent hardening (see CHANGELOG.md for the full list):
> - **v0.3.5** — re-auth status is driven by a **live refresh-token check** against Google
>   (not a fixed 7-day guess), plus a `productionMode` flag (manual checkbox + auto-learn)
>   that drops the countdown; **pre-warms the uvx/workspace-mcp cache** (launch + every 6h)
>   so a workspace-mcp bump doesn't time out Claude's MCP attach.
> - **v0.3.6** — autostart uses a Task Scheduler "At log on" task (per-user, no admin) with
>   the `HKCU\…\Run` value as fallback, so it survives Windows **Fast Startup**.
> - **v0.3.7** — sign-in callback window extended to **10 min** (unverified-app consent,
>   esp. a personal @gmail with restricted scopes, can take >3 min).
> - **v0.3.8** — *attempted* fix for the first-run setup screen showing falsely at boot: the
>   credential read retries when Windows Credential Manager is briefly unavailable after
>   login. It kept happening — the retry was treating a symptom, see v0.3.9.
> - **v0.3.9** — the real cause of the recurring "not set up" screen: `settings.json` was
>   written in place, so an unclean shutdown could truncate it, and the next save persisted
>   `{}` over it — permanently erasing the Client ID. Settings are now written **atomically**
>   with a rolling `.bak`, recovered or quarantined when corrupt, and **never** overwritten
>   when they cannot be read (§4 item 7). v0.3.8's Credential Manager retry was treating a
>   symptom. Also: the Claude Desktop entry is **restored on launch** if a Claude reinstall
>   replaced `claude_desktop_config.json` and dropped it.
> - **v0.4.0** — the connector key is now **`MultiMCP`** (was `google_workspace`; the legacy
>   key is deleted when we write, so nobody ends up with two connectors). Fixes the spurious
>   Google sign-in tabs: `MCP_SINGLE_USER_MODE=1` removes the false "not authenticated"
>   verdict on every account after the first (§6c), and `BROWSER` points at a no-op shim so
>   the background server physically cannot open a tab (§6d). Config repair now detects drift
>   in **any** load-bearing env key, not just the port — without that, machines with an
>   existing entry would never receive fixes like this one (§6a).
>
> Port design (v0.3.4; corrected in v0.4.0): the interactive **sign-in** uses port **8000**
> (the only registered redirect URI); **Claude's** background server is pinned to **9000** so
> the two never contend. This paragraph used to claim that Claude's background server never
> performs an interactive consent. That was wrong, and it is precisely the assumption that
> produced the v0.4.0 bug: the background server **can** reach the auth path and call
> `webbrowser.open()` itself. It is now dealt with three ways: (a) `MCP_SINGLE_USER_MODE=1`
> removes the spurious trigger; (b) `BROWSER` points at a no-op shim, so the server cannot
> open a browser tab even when a token really is dead; and (c) port 9000 is deliberately
> **not** registered as a redirect URI in Google Cloud, and must stay that way — a background
> process silently completing a consent, possibly for the wrong account, is worse than a
> visible failure. Multi-account remains fully supported (one shared credentials dir + one
> server entry; the account is selected per tool call).

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

- **Cannot bypass Google's rules.** While a Google OAuth app is in "Testing"
  status, refresh tokens expire after ~7 days, so each account needs periodic
  re-auth. The app's job is to make re-auth one click and warn before expiry — not
  to eliminate it. Removing the 7-day limit requires publishing the OAuth app to
  **Production** (free, instant); full Google *verification* (CASA, etc.) is only
  needed to remove the separate "unverified app" click-through, not the 7-day expiry.
  **Our own OAuth app is now published to production**, so in practice sign-ins do not
  expire weekly; the Testing-mode machinery below still exists because a freshly created
  Google Cloud project always starts there.
- **Cannot detect the OAuth app's publishing status via an API.** No user-token API
  reveals whether the consent screen is "Testing" vs "In production", so the app does
  not try. Instead it **verifies each refresh token directly against Google** (a real
  `refresh_token` grant) — ground truth in either mode — and exposes a `productionMode`
  flag (manual checkbox + auto-learn) to drop the 7-day countdown. See §4 item 3.
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
3. **Status dashboard** — for each account show connected / expired status,
   **verified live** by performing a real `refresh_token` grant against Google (on
   launch, every 6h, and via **Check now**): HTTP 200 → token works
   ("connected ✓ · verified Xm ago"); `invalid_grant` → dead ("re-auth needed");
   other/transient → keep prior state. In Testing mode a ~7-day countdown is also
   shown as a fallback; a `productionMode` flag (manual checkbox + auto-learn when a
   token outlives 7 days, persisted in settings.json) drops it. The refresh check uses
   the `refresh_token`/`client_id`/`client_secret`/`token_uri` already in each
   credential file — it never mutates those files (verify state lives in
   `accounts.json`).
4. **One-click re-auth** — re-run the sign-in for any account (the routine answer
   to a dead/expired token).
5. **Claude Desktop wiring** — read, merge, and write the `mcpServers` entry in
   `claude_desktop_config.json` so the user never edits JSON by hand. Always merge
   (never clobber other servers) and back up before writing. The entry's key is the
   name Claude displays for the connector: **`MultiMCP`** (§6a). The app also
   **repairs** the entry on every launch: it restores the entry if a Claude Desktop
   reinstall replaced the file and dropped it (guarded by a `claudeConfigWritten`
   marker, so we never add an entry on a machine we never set up), migrates a legacy
   `google_workspace` entry to the new key, and rewrites the entry when the command
   path or any load-bearing env key has drifted.
6. **Diagnostics & cache pre-warm** — "Test" button launches the server briefly and
   surfaces logs; prerequisite checks for `uv`/`uvx` and Python; and a background
   **pre-warm** of `uvx workspace-mcp` (on launch + every 6h) so the one-time install of
   a new workspace-mcp version happens here, not on Claude's MCP attach path (which would
   otherwise time out → "Could not attach to MCP server MultiMCP").
7. **Durable settings (v0.3.9)** — `settings.json` (Client ID, credentials dir,
   autostart, window bounds, `claudeConfigWritten`) holds configuration that cannot be
   reconstructed, so it is written **atomically**: temp file → `fsync` → rename over the
   primary (atomic on NTFS), with the previous good copy kept in `settings.json.bak`.
   Reads distinguish four states that must never be conflated — `missing` (fresh
   install, `{}` is correct), `ok`, `recovered` (unparseable, but the backup was good;
   the primary is restored immediately) and `quarantined` (corrupt with no usable
   backup: the ruined file is renamed to `settings.json.corrupt-<timestamp>` so the app
   can still be reconfigured, and the UI offers Import). A file that cannot be **read**
   at all (locked, antivirus, permissions) is `unusable`: the app **refuses to write
   over it**. The old code collapsed all of these into `return {}`, so a single bad read
   plus a read-modify-write save (even just moving the window) erased the Client ID for
   good.

## 5. Prerequisites the app must check / guide

- **uv / uvx** — now **bundled in the installer**, so there is nothing for the user to
  install. `serverManager.resolveUvxPath()` prefers the bundled copy
  (`<resources>/uv`, or `vendor/uv` in dev) and only falls back to `where uvx` on a
  machine that happens to have its own. The absolute path it returns is what goes into
  Claude's config, because Claude launches with a minimal PATH.
- **Python 3.10+** (uv auto-provisions this).
- Google Cloud project already set up (done): OAuth client (Web application),
  standard **Gmail API**, **Google Drive API**, and **Google Calendar API** enabled,
  consent screen = **External**, and the app's local redirect URI present on the OAuth
  client (see §7). While the consent screen is in **Testing**, every account must also be
  added as a **test user**; once the app is published to production that is no longer
  required.

> NOTE: `workspace-mcp` uses the *standard* Google APIs
> (`gmail.googleapis.com`, `drive.googleapis.com`, `calendar-json.googleapis.com`),
> NOT the `*mcp.googleapis.com` preview APIs. Make sure the **standard Google
> Calendar API** is enabled — that one was not enabled during initial setup.

## 6. workspace-mcp invocation

### a) Claude Desktop config entry the app writes
Target file (Windows): `%APPDATA%\Claude\claude_desktop_config.json`

The **key** of the entry is the name Claude Desktop shows for the connector, so as of
v0.4.0 it is `MultiMCP` (`SERVER_KEY` in `claudeConfig.js`). It used to be
`google_workspace`, which matched nothing the user could see. When the app writes the
entry it **deletes** the legacy key, so an upgrading user never ends up with two
connectors — which would also spawn two servers, the stale one still carrying the old
env and still opening OAuth tabs.

```jsonc
{
  "mcpServers": {
    "MultiMCP": {
      "command": "<absolute path to uvx>",   // bundled uvx; absolute, avoids PATH issues
      "args": ["workspace-mcp", "--tools", "gmail", "drive", "calendar"],
      "env": {
        "GOOGLE_OAUTH_CLIENT_ID": "<client id>",
        "GOOGLE_OAUTH_CLIENT_SECRET": "<client secret>",   // see §9; required for a Web client to refresh
        "GOOGLE_MCP_CREDENTIALS_DIR": "<fixed shared path>",
        "WORKSPACE_MCP_CREDENTIALS_DIR": "<the same path>",
        "OAUTHLIB_INSECURE_TRANSPORT": "1",
        "WORKSPACE_MCP_PORT": "9000",
        "PORT": "9000",
        "WORKSPACE_MCP_BASE_URI": "http://localhost",
        "MCP_SINGLE_USER_MODE": "1",
        "BROWSER": "%LOCALAPPDATA%\\MultiMCP\\no-browser.cmd"
      }
    }
  }
}
```

Every key is there for a reason:
- **`GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`** — the single OAuth client
  shared by all accounts. The secret is injected at write time from Credential Manager
  because the Python server cannot read it from there itself (tradeoff in §9; setting
  `injectSecretIntoConfig: false` omits it, at the cost of token refresh).
- **`GOOGLE_MCP_CREDENTIALS_DIR`** — the shared token store (§3): the same dir the tray
  app primes sign-ins into.
- **`WORKSPACE_MCP_CREDENTIALS_DIR`** — newer workspace-mcp prefers this name and reads
  it *first*. Set to the same path, so a stray machine-level value cannot silently win
  and point the server at an empty dir — which would make every account look signed out,
  i.e. the same bug as §6c by another route.
- **`OAUTHLIB_INSECURE_TRANSPORT=1`** — permits the plain-HTTP localhost callback.
- **`WORKSPACE_MCP_PORT=9000` / `PORT=9000`** — pin Claude's background server to its own
  port so it never contends with the tray app's sign-in on 8000. Both are set because the
  bare `PORT` is read *before* `WORKSPACE_MCP_PORT`: a machine-level `PORT=8000` would
  otherwise collapse the 8000/9000 split and steal the registered sign-in port.
- **`WORKSPACE_MCP_BASE_URI=http://localhost`** — keeps the server's own local URLs on
  localhost.
- **`MCP_SINGLE_USER_MODE=1`** — the fix for the spurious sign-in tabs. Despite the name
  it does **not** restrict the connector to one account; all accounts keep working. See
  §6c. `USER_GOOGLE_EMAIL` is deliberately left **unset**.
- **`BROWSER`** — a no-op shim, so the background server cannot open a browser tab even
  if a token really is dead. Only set when the shim actually exists on disk. See §6d.

Notes:
- `command` MUST be an absolute path on Windows; Claude Desktop launches with a
  minimal PATH so bare `uvx` often fails.
- Merge into any existing `mcpServers`; back up the file first.
- **Staleness check (`CRITICAL_ENV`).** On launch the app compares the existing entry
  with the one it would write today and rewrites it if the command is bare or points at
  a file that no longer exists, **or if any of these env keys differ**:
  `MCP_SINGLE_USER_MODE`, `BROWSER`, `WORKSPACE_MCP_PORT`, `GOOGLE_MCP_CREDENTIALS_DIR`,
  `GOOGLE_OAUTH_CLIENT_ID`. Until v0.4.0 only the port was compared, so a machine with an
  existing entry would have reported "entry ok" forever and never received the fix. Any
  key that becomes load-bearing must be added to `CRITICAL_ENV`, or existing installs
  will not get it.
- A leftover `google_workspace` entry counts as "not in sync" even when ours looks right.

### b) Transient sign-in flow the app drives (per account) — CONFIRMED
> Verified against workspace-mcp 1.21.1 source. The earlier streamable-http guess
> was wrong: there is no plain `/authorize` HTTP route. Auth is driven by an MCP
> **tool** over **stdio**.

The app launches the server in **stdio** mode (legacy OAuth 2.0; do NOT set
`MCP_ENABLE_OAUTH21`) and speaks newline-delimited JSON-RPC to it:
```
uvx workspace-mcp --tools gmail drive calendar      # stdio is the default
```
Env (`serverManager.baseEnv`): `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
`GOOGLE_MCP_CREDENTIALS_DIR` **and** `WORKSPACE_MCP_CREDENTIALS_DIR` (both, for the same
reason as §6a — newer workspace-mcp reads the latter first),
`OAUTHLIB_INSECURE_TRANSPORT=1`, `WORKSPACE_MCP_PORT=8000`. `BROWSER` is explicitly
**deleted** from the inherited environment here: this is the one flow that *must* open a
real browser, so it must never pick up the no-op shim of §6d.

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

### c) Why `MCP_SINGLE_USER_MODE=1` — the multi-account fix (v0.4.0)

**Symptom.** Using more than one account in a single Claude conversation opened a
browser tab per account, each landing on "Access blocked: this app's request is invalid
— Error 400: redirect_uri_mismatch".

**Cause — an upstream bug, not a dead token.** workspace-mcp binds the MCP session to
the **first** account that refreshes a token, and that binding is immutable
(`auth/oauth21_session_store.py:653-665`). For every **later** distinct account the
token refreshes successfully and is written to disk, and *then* the binding check raises
`ValueError`. A broad `except Exception` around the refresh swallows it and returns "no
credentials" (`auth/google_auth.py:1167-1172`), so the server concludes the user is not
signed in and calls `start_auth_flow()` → `webbrowser.open()` (`google_auth.py:554-562`,
gated only on `transport == stdio`, which is exactly how Claude runs it). Access tokens
last an hour, so this fired in essentially every real session, and the trigger was
**using multiple accounts** — the entire point of this app. Whichever account was touched
first worked; every later one opened a tab.

**Fix.** `MCP_SINGLE_USER_MODE=1` bypasses the session→user binding and looks credentials
up by the email the tool was called with. The name is a misnomer: it does **not** limit
us to one account. `USER_GOOGLE_EMAIL` is deliberately left unset — setting it would make
`user_google_email` optional and let a tool call silently default to the wrong account.
Delivered as an **env var, not the `--single-user` CLI flag**: an unknown env var is
inert, but an argparse flag that upstream renames is a hard `exit(1)` and the connector
dies.

**Verified.** Five accounts with expired tokens in one server process — before: 4 auth
demands / 4 tabs. After: 0 / 0, and all five accounts read mail.

### d) The no-browser shim (belt and braces)

Even with §6c, a *genuinely* revoked token, a deleted credential file, or a future
upstream regression can still reach `start_auth_flow()`. So Claude's background server
gets `BROWSER` pointed at a shim the app writes (and repairs) on every launch at
`%LOCALAPPDATA%\MultiMCP\no-browser.cmd`: it appends the URL to
`suppressed-auth-urls.log` and exits. CPython puts `$BROWSER` entries at the front of
`webbrowser._tryorder`, so the real browser is never reached. Two constraints are
load-bearing: the shim must **exit 0** (a non-zero exit means "failed" and `webbrowser`
falls through to the real browser), and `BROWSER` must be a **bare path with no spaces
and no arguments** (the whole string is treated as the executable). If the shim is not on
disk, the app does not set `BROWSER` at all — pointing it at a missing file fails *open*.

Suppressing the tab must not make a real re-auth invisible. As part of the expiry check
(launch + every 6h) the app reads what the shim swallowed, **verifies each of those
accounts against Google for real**, and raises a tray notification only for the ones
whose token is genuinely dead. The user then re-auths from the app, which opens a real
browser on the registered `:8000`. The tray app's own sign-in never gets this shim.

## 7. Google Cloud one-time items still required

1. Enable the **standard Google Calendar API** (`calendar-json.googleapis.com`).
2. On the OAuth client (Web application), add redirect URI:
   `http://localhost:8000/oauth2callback`
   (keep the existing `https://claude.ai/api/mcp/auth_callback` too — harmless).
   **Do NOT add `http://localhost:9000/oauth2callback`.** Port 9000 is Claude's
   background server, and leaving it unregistered is a deliberate safety interlock:
   any OAuth flow that server starts is then incapable of completing (§6a, §9).
3. Consent screen Audience = External. While it is in **Testing**, all 5 emails must be
   added as Test users; the app is now **published to production**, so new accounts no
   longer need pre-listing (and sign-ins no longer expire weekly — see §2).

## 8. UI (React) — AS BUILT

Dark "control room" aesthetic, amber accent, monospace for status/IDs.

- **Header**: full-width intro paragraph describing what the app does (the product
  name lives in the OS title bar: "MultiMCP — Google Workspace Manager"). No native
  menu bar — a single **? Help** button (on the Accounts row) opens `HELP.md`.
- **Dashboard**: add-account row; a **Check now** button (verifies every account
  against Google on demand); account cards (email, status dot, live
  "connected ✓ · verified Xm ago" / Testing-mode countdown / "re-auth needed",
  **Re-auth** + **Remove**); a Claude Desktop config strip ("in sync" shows a green
  **✓ Done**, otherwise **Write config**); a mode-aware re-auth note; an **"OAuth app
  published to production"** checkbox (drops the 7-day countdown; auto-ticks once a
  token outlives 7 days); a **Start with Windows** checkbox (default on); a Debug-log
  row with a **View log** button (in-app modal viewer).
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
  dashboard. The same pass reports any sign-in demand the no-browser shim swallowed,
  after verifying the account really is dead (§6d).
- **First-run screen tells the truth** (v0.3.9): if sign-ins and a stored Client Secret
  exist but the Client ID has gone, it says the settings appear to have been lost and
  points at Import, instead of greeting an already-configured user as brand new.

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
- Open external URLs (OAuth) in the system browser, not in an Electron window — but only
  from the tray app's own, user-initiated sign-in. Claude's **background** server must
  never open a browser: it gets a no-op `BROWSER` shim (§6d), and its port (9000) is
  deliberately left out of the OAuth client's redirect URIs (§7) so that any consent flow
  it does manage to start cannot complete. A background process silently obtaining
  consent — possibly, with `prompt=select_account`, for the *wrong* account, overwriting
  that account's token file — is worse than a visible failure.
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
7. [DONE] Diagnostics + polish + packaging (live E2E + `npm run dist`).

> Code-level `TODO(claude-code)` markers from the scaffold are all resolved, the live
> end-to-end run is done, and the NSIS installer ships with every
> [GitHub Release](https://github.com/taipeiviking/MultiMCP/releases). This section is
> kept as a record of how the app was built; ongoing changes are tracked in
> [CHANGELOG.md](CHANGELOG.md).
