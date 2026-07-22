# Changelog

All notable changes to **Google Workspace Manager** (MultiMCP), newest first. Every version is
also a [GitHub Release](https://github.com/taipeiviking/MultiMCP/releases) with the Windows
installer attached. Versioning is `MAJOR.MINOR.PATCH`.

## v0.8.2 — 2026-07-16
*Autostart stays in the tray on restart — no more dashboard popping open every login.*

### Fixed
- **The main window no longer opens on every PC restart.** Autostart deliberately registers **two** launchers for reliability — a scheduled logon task *and* an HKCU `Run` key — and both fire at login with `--hidden`. The first instance starts hidden and takes the single-instance lock; the second can't, so it fell through to the `second-instance` handler, which **unconditionally showed the window**. The handler now ignores autostart relaunches (they carry `--hidden`) and only surfaces the dashboard for a genuine user-initiated relaunch (e.g. double-clicking the icon). Net: a restart lands silently in the system tray, exactly as intended.

## v0.8.1 — 2026-07-15
*ChatGPT Codex: clean up the old connector so it can't reopen sign-in tabs.*

### Fixed
- **The ChatGPT Codex config now drops the old `google_workspace` entry when it writes the new
  `MultiMCP` one.** On a machine whose `~/.codex/config.toml` still had the pre-rename
  `[mcp_servers.google_workspace]` block (written by an older build), Codex kept spawning **both**
  Workspace servers — and the old one lacked the OAuth-tab fix (`MCP_SINGLE_USER_MODE` + the no-op
  `BROWSER` shim), so it still threw a Google sign-in tab on the second account in a session. The
  Codex service now strips the legacy entry on write, reports it as "not in sync" while one lingers,
  and **auto-migrates it on launch** — the exact cleanup the Claude Desktop side already did. (The
  Codex CLI was always detected correctly at `%LOCALAPPDATA%\OpenAI\Codex\bin`; detection was never
  the problem.) Your other Codex servers (e.g. `node_repl`) and all non-MCP settings are preserved
  untouched, with a timestamped `config.toml` backup.

### Internal
- New `tomlEdit.removeTable()` primitive (structural, comment-safe table removal) with adversarial
  tests; the legacy drop is a separately-validated edit because `validateEdit` forbids any sibling
  under `mcp_servers` from changing during the `MultiMCP` upsert.

## v0.8.0 — 2026-07-15
*Label your accounts ("Personal", "Work") so the AI picks the right one.*

### Added
- **Account labels.** Give each account a short label — **Personal**, **Work**, **Assaya** — right on
  its card. When you ask "check my personal email", the AI can now map that to the correct account
  instead of guessing (it picked the wrong one before). The labels are woven into the **usage rules**
  the "Add usage rules…" button writes, so a fresh session gets the mapping too: *Connected accounts:
  clas.sivertsen@gmail.com (Personal), clas@liquacool.com (Work), …*

## v0.7.1 — 2026-07-15
*Make the Codex usage rules actually stick.*

### Changed
- The **ChatGPT Codex** usage rules now also write a note into Codex's **durable memory**
  (`~/.codex/memories/…/notes`), not just `AGENTS.md`. In practice `AGENTS.md` alone wasn't always
  enough — a fresh Codex task could still fall back to its built-in single-account Gmail — and the
  memory note is what makes a new session comply. (Codex's own memory system treats these notes as
  authoritative.) The button now shows both targets, detects an existing note so it never
  duplicates, and only offers the memory note when Codex's memory store exists.
- The rule wording is stronger and now covers skill-recommended integrations too ("even if one is
  available or recommended"), while keeping the point that several accounts are connected and the
  agent must always name the account.

## v0.7.0 — 2026-07-15
*Teach the AI to actually use MultiMCP — not its built-in single-account Gmail.*

### Added
- **"Add usage rules…" button on each card.** A connector alone isn't enough: a client that also
  has a built-in Gmail/Drive/Calendar integration will often reach for *that* instead — and only for
  the one account it was set up with. This button adds a short standing instruction telling the AI to
  use **only MultiMCP** for Google Workspace, and to **always specify which of your connected
  accounts** to act on.
- It opens a **diff-style preview** of exactly what will be added, and **checks whether the guidance
  is already there** — if so, it doesn't duplicate it and marks the step done. (Rules you wrote
  yourself, like an existing `AGENTS.md`, are recognised too.)
- Targets per client:
  - **ChatGPT Codex** → `~/.codex/AGENTS.md` (the file Codex reads as rules).
  - **Claude** → `~/.claude/CLAUDE.md` (Claude Code's memory file) as a diff, **and** a copy box for
    **Claude Desktop → Settings → custom instructions**, since Claude Desktop has no rules file.
- The **Done** button moved left; the new **usage-rules** button sits to its right.

## v0.6.0 — 2026-07-15
*A "how to use it here" guide on each connector card.*

### Added
- Each config card now has a **"How to use in …" link** that opens a step-by-step guide on GitHub
  for that specific client — [Claude Desktop](docs/README_Claude.md) and
  [ChatGPT Codex](docs/README_ChatGPT.md). Each guide covers install, configuration, restarting the
  client, example prompts you can type in a chat, how to verify it works, and troubleshooting.

## v0.5.2 — 2026-07-15
*Naming.*

### Changed
- The Codex row now says **ChatGPT Codex**, not just "Codex" — it is clearer which product it means.

## v0.5.1 — 2026-07-15
*Keeps itself correct while you aren't looking.*

### Fixed
- **The connector entry can no longer be undone by Claude Desktop.** Claude writes
  `claude_desktop_config.json` too — it persists the connector list it loaded at *its* startup back
  to the file. So a Claude that is still running an old config would put the old `google_workspace`
  entry back, and your **next** Claude launch would load it: the OAuth-tab bug appearing to rise
  from the dead. (Seen live: a key we had already renamed reappeared while Claude was open.) The app
  now **watches both client config files and repairs them within a second** of any external change,
  so the order in which you restart things no longer matters.
- **A corrupted token file now repairs itself instead of demanding a re-auth.** `workspace-mcp`
  writes token files by truncating and rewriting them, with no lock — which was harmless with one
  client and is not, now that Claude *and* Codex can each run their own copy of the server against
  the same credentials folder. We cannot fix their writer, so the app keeps a shadow copy of every
  healthy token file and restores it automatically if one is found damaged. Nothing of value is
  lost: the access token is regenerated on demand from the refresh token, which is the part that
  actually matters.
- Claude's config is now written **atomically** (temp file, flushed, renamed) and re-read to verify
  what actually landed, rolling back to the backup if not — the same treatment `settings.json` got
  in v0.3.9 and the Codex config got in v0.5.0. A locked or unreadable config is also no longer
  mistaken for an empty one, which would have silently dropped your other MCP servers.

### Changed
- The header no longer claims this app is only for Claude Desktop — it serves Codex too.
- The Codex row is no longer painted red when you simply haven't set it up yet. Not doing an
  optional thing is not an error.

## v0.5.0 — 2026-07-15
*The same accounts, now in OpenAI Codex too.*

### Added
- **"Write Codex config" button.** Your Google accounts can now be used from **OpenAI Codex** as
  well as Claude Desktop, from the same sign-ins — no re-authorizing. The app merges a `MultiMCP`
  server into `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`). Codex reads that same file
  whether you use the CLI, the IDE extension, or Codex inside the ChatGPT desktop app. Ordinary
  ChatGPT conversations **cannot** use it — they only support remote MCP servers, not local ones.
- The Codex row is hidden behind a plain explanation when Codex isn't installed, rather than a
  dead button.

### Notes on how it is done
- **Codex gets its own port (9001).** Every MCP client spawns its *own* copy of the server, so
  Claude (9000), Codex (9001) and the app's sign-in (8000) must never collide. Like 9000, port
  9001 is deliberately **not** a registered redirect URI — the same safety interlock.
- `MCP_SINGLE_USER_MODE=1` and the no-browser shim are set for Codex too, so it cannot suffer the
  spurious sign-in tabs fixed in v0.4.0. Codex wipes the environment before launching a server, so
  every variable is passed explicitly — including `BROWSER`, which *must* be set, because an unset
  one falls through to the real browser.
- Timeouts are raised (`startup_timeout_sec = 120`, `tool_timeout_sec = 300`): Codex's 10-second
  default kills the server during a cold `uvx` start, and a Gmail batch fetch can outrun the
  60-second tool default.
- **Your `config.toml` is edited surgically, never rewritten.** It is a file you and the Codex app
  both own — it holds your model, plugins, project trust levels and other MCP servers. The app
  replaces only its own table, preserving every other byte including comments; it validates the
  result in memory *before* touching the disk, takes a timestamped backup, writes atomically, then
  re-reads and re-validates — and restores the backup if anything is off. If it finds a shape it
  cannot edit safely, it refuses and says so rather than guessing.
- The client secret is written into `config.toml`, exactly as it already is for Claude
  (SPEC §9) — the server needs it to refresh tokens.

### Known limitation
- Claude and Codex share one credentials directory, and `workspace-mcp` writes token files
  non-atomically. If both refresh the *same* account at the same instant, that account's token can
  be corrupted and need re-signing. Narrow window, but real — and using both clients at once is
  what makes it reachable.

## v0.4.0 — 2026-07-15
*No more surprise Google sign-in tabs — and the connector is now called **MultiMCP**.*

### Fixed
- **The connector no longer opens unwanted Google sign-in tabs.** Using more than one account
  in a single Claude conversation would open a browser tab per account — every one of them
  landing on *"Access blocked: this app's request is invalid — Error 400: redirect_uri_mismatch"*.
  The cause was in `workspace-mcp`: it binds the MCP session to the **first** account that
  refreshes a token, and that binding is immutable
  (`auth/oauth21_session_store.py:653-665`). For every *later* account the token refreshes
  successfully and is written to disk — and then the binding check raises `ValueError`, which a
  broad `except Exception` around the refresh swallows and returns as "no credentials"
  (`auth/google_auth.py:1167-1172`). The server concludes you are not signed in and launches an
  OAuth flow. Because access tokens last an hour, this fired in essentially every real session —
  it was triggered by *using multiple accounts*, which is the whole point of this app. We now
  run the server with `MCP_SINGLE_USER_MODE=1`, which bypasses that session→user binding and
  looks credentials up by the email the tool was called with. (Despite the name it does **not**
  limit you to one account.)
- **Claude's background server can no longer open a browser at all.** Even with the above, a
  genuinely revoked token could still reach the same code path. Its `BROWSER` is now pointed at a
  no-op shim, so it is physically incapable of hijacking your browser. When an account really does
  need signing in, the app tells you with a notification instead — sign in from the app, on the
  registered port, as always.
- **Port 9000 is deliberately still not a registered redirect URI.** That is a safety interlock,
  not an oversight: a background process silently completing an OAuth consent — possibly for the
  wrong account — is worse than a visible failure.

### Changed
- **The connector is now called `MultiMCP` in Claude, matching the app.** It used to appear as
  `google_workspace`, which made it unclear the tray app and the connector were the same thing.
  The old entry is removed automatically when the new one is written — you won't get two.
- Config repair now notices when *any* load-bearing setting has drifted, not just the port, so
  existing installs actually receive fixes like this one.

## v0.3.9 — 2026-07-14
*Stops a PC restart from wiping your settings — the real cause of the "not set up" screen.*

### Fixed
- **Your configuration can no longer be lost on reboot.** `settings.json` was written with a
  plain in-place write, so an unclean shutdown could leave it truncated. The next read then
  silently fell back to "empty settings", and the next save (even just moving the window) wrote
  that emptiness back over the file — permanently erasing the Client ID. Settings are now written
  **atomically** (temp file, flushed, then renamed) and a rolling `settings.json.bak` is kept.
  A corrupt file is recovered from the backup automatically, and if the settings can't be read at
  all, the app now **refuses to overwrite them** rather than replacing them with an empty file.
  This — not the Credential Manager timing fixed in v0.3.8 — was the real reason the setup screen
  kept coming back.
- **The connector is restored automatically after a Claude Desktop reinstall.** Reinstalling
  Claude replaces `claude_desktop_config.json`, which dropped the `google_workspace` entry. The
  app now puts it back on launch on any machine where it previously wrote it.

### Changed
- **The first-run screen tells the truth when settings go missing.** If sign-ins and a stored
  Client Secret are still present but the Client ID is gone, the app now says *"Your settings
  appear to have been lost"* and points to Import — instead of greeting you as a brand-new user.

## v0.3.8 — 2026-07-14
*No more false "not set up" screen at boot.*

### Fixed
- **Setup screen no longer appears at startup when you're already configured.** When the app
  autostarts hidden right after login (especially after a Fast Startup resume), Windows
  Credential Manager can briefly be unavailable, so the first credentials read came back empty
  and the app fell to the first-run "Connect your Google OAuth client" screen — even though the
  Client ID and secret were safely stored. Now the main process retries the Credential Manager
  read with a short backoff, and the UI re-checks a few times before showing setup. Your data
  was never lost in this case; a restart already fixed it — this stops it happening.

## v0.3.7 — 2026-07-13
*Longer sign-in window for unverified-app consent.*

### Fixed
- **Sign-in no longer times out mid-consent.** The callback server waited only 3 minutes,
  but an **unverified** app makes you click through several "Google hasn't verified this app"
  screens — especially for a **personal @gmail account** with restricted scopes — which often
  takes longer. When the window elapsed, the browser redirect landed on a closed port and
  "nothing happened." The wait is now **10 minutes**, and the timeout message explains what to
  do. (Tip: the fastest path is still to click through consent promptly.)

## v0.3.6 — 2026-07-13
*More reliable autostart (survives Windows Fast Startup).*

### Fixed
- **Autostart now uses a Task Scheduler "At log on" task**, not just the `HKCU\…\Run`
  registry value. Run-key entries can be silently skipped after a Windows **Fast Startup**
  (hybrid shutdown) resume, so the tray app sometimes didn't come back after boot. The logon
  task fires reliably; the Run key is kept as a fallback. The task is registered per-user via
  PowerShell's `Register-ScheduledTask` (no admin needed), created/reconciled on launch, and
  removed on uninstall.
- Note: the app starts **hidden in the system tray** (no window) — expand the tray's `^`
  chevron to find it. This is by design; "no window" doesn't mean it didn't start.

## v0.3.5 — 2026-06-24
*Live verification, production mode, and a faster Claude attach.*

### Added
- **Live re-auth status.** Each account is verified against Google with a real token refresh —
  on launch, every 6 h, and via a new **Check now** button. Cards show
  "connected ✓ · verified Xm ago", and only say "re-auth needed" when a sign-in *actually* fails
  (no more guessing from a fixed 7-day clock).
- **"OAuth app published to production" toggle.** Removes the weekly re-auth countdown once your
  OAuth consent screen is published to production — and auto-detects production once a token
  survives past 7 days.
- **New guide:** [`docs/ADD_ACCOUNT.md`](docs/ADD_ACCOUNT.md) — an illustrated walkthrough for
  adding a Google account and getting out of Testing mode.

### Fixed
- **"Could not attach to MCP server google_workspace."** A cold-start timeout: when
  `workspace-mcp` publishes a new version, `uvx` cold-installs ~90 packages, which could exceed
  Claude Desktop's MCP attach timeout. The app now **pre-warms** the engine in the background
  (on launch + every 6 h), so that one-time install happens off Claude's attach path.

### Notes
- Multiple Google accounts are fully supported — add each email and Sign in; Claude picks the
  account per request via `user_google_email`.

## v0.3.4 — 2026-06-04
### Fixed
- **`redirect_uri_mismatch` during sign-in (root cause).** The tray app's interactive sign-in
  and Claude's persistent server both started their OAuth helper on port **8000**; whichever
  lost the race fell back to an unregistered port, breaking consent. Claude's background server
  is now pinned to **9000** (it only refreshes tokens, so it needs no registered redirect URI),
  keeping **8000** free for the interactive sign-in. Sign-in also verifies 8000 is free first and
  shows a clear error instead of silently using 8002. Stale configs auto-heal to 9000 on launch.

## v0.3.3 — 2026-06-04
### Fixed
- Pinned the OAuth callback port to **8000** (the registered redirect URI) — one cause of
  `redirect_uri_mismatch`. Fully resolved in v0.3.4.

## v0.3.2 — 2026-06-03
### Added
- App version shown in the OS title bar.
### Changed
- The `uvx` prerequisite check now actually runs `uvx --version` (not just a path check), so a
  blocked or quarantined engine is detected and reported.

## v0.3.1 — 2026-06-03
### Fixed
- **`spawn uvx ENOENT`.** The app auto-heals a stale Claude config on launch, rewriting a bare
  `uvx` (or a path that no longer exists) to the bundled absolute `uvx` path.

## v0.3.0 — 2026-06-03
### Added
- **Bundled `uv`/`uvx` engine** in the installer — no separate engine install, and Claude can
  always launch it by absolute path. The footer shows "Engine ready (bundled)".

## v0.2.5 — 2026-06-03
### Changed
- Installer shows detailed progress, including when it closes a running instance before updating.

## v0.2.3 — 2026-06-03
### Added
- App version shown in the title bar and an in-app badge.
### Changed
- Made the **Import settings** button prominent.

## v0.2.2 — 2026-06-03
### Internal
- Track the NSIS installer source (`build/installer.nsh`) needed to build the installer.

## v0.2.1 — 2026-06-03
### Added
- Allow **Import settings** from the first-run screen — move a setup to a new computer without
  retyping the Client ID/Secret first.

## v0.2.0 — 2026-06-03
### Added
- **Export / Import settings** — move a whole setup (Client ID + secret, accounts, and sign-in
  tokens) between computers in one file.
- README "Connecting to Claude Desktop" + export/import documentation.

## v0.1.0 — 2026-06-01
- First public Windows installer via GitHub Releases (includes the SmartScreen "unverified app"
  note for unsigned builds).
