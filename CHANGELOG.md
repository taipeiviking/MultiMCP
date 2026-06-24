# Changelog

All notable changes to **Google Workspace Manager** (MultiMCP), newest first. Every version is
also a [GitHub Release](https://github.com/taipeiviking/MultiMCP/releases) with the Windows
installer attached. Versioning is `MAJOR.MINOR.PATCH`.

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
