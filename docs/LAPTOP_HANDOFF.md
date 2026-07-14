# Paste-ready prompt — new "MultiMCP" session on the laptop

Copy everything inside the fence into a new Claude Code session on the laptop, with the
working folder set to the MultiMCP repo. (Written 2026-07-15, current release **v0.5.1**.)

---

```
You are picking up work on MultiMCP on my laptop while I'm travelling. Read this whole
brief before touching anything.

## What MultiMCP is

A Windows Electron tray app, shipped as "Google Workspace Manager", that wraps the Python
`workspace-mcp` server (run through a bundled `uvx`) so several Google Workspace accounts
can be used from AI clients as one MCP connector (Gmail / Drive / Calendar).

- It serves BOTH Claude Desktop AND OpenAI Codex, from the same sign-ins.
- Repo: https://github.com/taipeiviking/MultiMCP  (public)
- Local checkout on this laptop: C:\Users\class\git\MultiMCP  (confirm; adjust if different)
- Current release: v0.5.1 — installer attached to the GitHub release.
- 5 accounts are connected on my machines: clas@assaya.com, clas@advoli.com,
  clas@liquacool.com, clas.sivertsen@gmail.com, cs@apollo.bio

## HARD GUARDRAILS — read twice, these matter more than the task

1. GIT ISOLATION. `C:\Users\class\git` is ITSELF a different repo
   (taipeiviking/www.liquacool.com), and MultiMCP is nested inside it. There is also a
   sibling `assaya` repo with a dirty working tree.
   -> ONLY ever run git commands against C:\Users\class\git\MultiMCP.
   -> NEVER run git/gh against the parent folder or against assaya.
   -> Git identity is repo-LOCAL (user.name=taipeiviking). NEVER use `git config --global`.

2. TWO GITHUB ACCOUNTS. `gh` has both `classivertsen` (active by default) and
   `taipeiviking` (owns MultiMCP). To publish a release: `gh auth switch --user taipeiviking`,
   publish, then IMMEDIATELY `gh auth switch --user classivertsen` and verify it switched
   back. Pushing over SSH needs no switch (repo-local sshCommand + `github-taipeiviking` alias).

3. NEVER kill processes by name — always by PID. Killing by name once took out Claude
   Desktop's own MCP server mid-session. Also: after killing the tray app, CONFIRM it is
   gone before relaunching — a silently-failed kill has already cost me a wasted test cycle.

4. NEVER call the MultiMCP / google_workspace MCP tools to "test" an auth problem. Before
   v0.4.0 that opened real browser tabs on my screen. To exercise the server, spawn your OWN
   copy over stdio with BROWSER pointed at the no-op shim
   (%LOCALAPPDATA%\MultiMCP\no-browser.cmd) and use a COPY of the credentials dir.

5. Never put the OAuth client secret in a file you create, in a commit, or in chat. It lives
   in Windows Credential Manager. (It IS deliberately injected into the two client config
   files — a documented trade-off, SPEC §9 — but don't print or copy it anywhere else.)

6. Ask me before anything destructive, anything touching my global git config or other repos,
   and before publishing a public release.

## What has shipped (don't re-investigate solved problems)

v0.3.9 — a PC restart could WIPE settings.json. It was written with a plain in-place write, so
an unclean shutdown truncated it; the code then swallowed the parse error, returned "empty
settings", and the next save (even just moving the window) persisted that emptiness over the
file — permanently erasing the Client ID. This, not Credential Manager timing (v0.3.8's guess),
was the real cause of the recurring "not set up" screen. Settings are now written atomically
with a rolling .bak; corrupt files recover from it; unreadable files are never overwritten.

v0.4.0 — the connector opened unwanted Google sign-in tabs, all failing with
"Error 400: redirect_uri_mismatch". Root cause is a bug in upstream workspace-mcp, NOT a dead
token: it binds the MCP session to the FIRST account that refreshes a token, IMMUTABLY
(auth/oauth21_session_store.py:653-665). Every LATER distinct account refreshes fine, persists
fine, then trips ValueError on the rebind — swallowed by a broad `except Exception` around the
refresh (auth/google_auth.py:1167-1172) and returned as "no credentials". The server concludes
you're not signed in and calls webbrowser.open(). Access tokens last an hour, so it fired in
essentially every real session, triggered by USING MULTIPLE ACCOUNTS — the whole point of the
app. Fixed with MCP_SINGLE_USER_MODE=1 (bypasses the session->user binding; despite the name it
does NOT limit you to one account), plus a no-op BROWSER shim so the background server physically
cannot open a tab. Connector renamed google_workspace -> MultiMCP.

v0.5.0 — "Write Codex config" button. Codex (CLI, IDE extension, and Codex INSIDE the ChatGPT
desktop app) supports local stdio MCP servers and reads ~/.codex/config.toml. Ordinary ChatGPT
conversations CANNOT — they only support remote MCP. Codex gets its own port (9001) because every
MCP client spawns its OWN server process. config.toml is edited surgically (it holds the user's
model, plugins, project trust levels and Codex's own node_repl server): validate in memory, back
up, write atomically, re-read and re-validate, roll back on failure, refuse rather than guess.

v0.5.1 — two things that could silently undo the above, now self-healing:
  (a) Claude Desktop WRITES claude_desktop_config.json too, persisting the connector list it
      loaded at ITS startup. A Claude still running an old config puts the old google_workspace
      entry back, and the next Claude launch loads it — the tab bug appearing to return. The app
      now WATCHES both client configs and re-heals within ~1.5s of any external change.
  (b) workspace-mcp writes token files by truncating and rewriting, with no lock. With Claude AND
      Codex each running their own server against one credentials dir, two simultaneous refreshes
      of the same account can leave a half-written token. We can't fix their writer, so the app
      keeps a shadow copy of every healthy token file and restores it automatically (watching the
      credentials dir, so within seconds). REPAIR, NOT PREVENTION — be honest about that.

Port design, and it must stay this way: tray app's interactive sign-in = 8000 (the ONLY redirect
URI registered in Google Cloud). Claude's background server = 9000. Codex's = 9001. 9000 and 9001
are DELIBERATELY unregistered — a safety interlock so a rogue background OAuth flow cannot
complete. Do NOT "fix" this by registering them.

## Your first job on this laptop

1. Confirm you're in C:\Users\class\git\MultiMCP and it is the MultiMCP repo (not the parent).
2. `git pull` — expect HEAD at or after the v0.5.1 commit, on `main`, clean.
3. Install v0.5.1: https://github.com/taipeiviking/MultiMCP/releases/latest
   (Google-Workspace-Manager-Setup-0.5.1.exe). It closes any running copy itself.
4. Launch Google Workspace Manager and leave it running. On launch it rewrites Claude's connector
   entry, starts the file watchers, and shadow-copies the token files. Check:
   %APPDATA%\google-workspace-manager\logs\app.log
5. Fully QUIT Claude Desktop (tray icon -> Quit, not just closing the window) and reopen it.
6. Verify: Claude's connector list shows MultiMCP (not google_workspace). Then, in ONE
   conversation, have Claude search mail across TWO OR MORE accounts. Expect it to work with ZERO
   browser tabs. That is the regression test for v0.4.0.
7. Optional: click "Write Codex config" if Codex is installed on this laptop, then verify with
   `codex mcp get MultiMCP` (codex is NOT on PATH; it lives at
   %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe). It must show startup_timeout_sec: 120 and
   tool_timeout_sec: 300 — Codex SILENTLY DROPS unknown keys, so that command is the only proof.
8. If the app opens on the first-run setup screen instead of the dashboard: settings.json was lost
   by the pre-v0.3.9 bug on this machine too. The screen now SAYS so. Recover with "Import
   configuration from a file..." using my exported backup .json. Tell me if you can't find one.

Report what you found before changing anything.

## Building and releasing from this laptop

- `npm run dist` -> dist\Google-Workspace-Manager-Setup-<version>.exe (~90 MB).
- KNOWN BUILD FAILURE on Windows without elevation: electron-builder fails extracting winCodeSign
  with "Cannot create symbolic link ... darwin/.../libcrypto.dylib". Those macOS symlinks are
  irrelevant to a Windows build. Fix without elevating: extract a cached winCodeSign .7z into
  %LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0 excluding darwin
  (7za x -bd -y "-o<dest>" <cache>.7z "-xr!darwin"), then rebuild. Confirm signtool.exe exists
  under windows-10\x64 there.
- ALWAYS confirm the new build actually installed before testing it. A silently-failed
  Stop-Process once meant I tested the OLD build and drew the wrong conclusion. Check the asar's
  timestamp, or grep the installed app.asar for a string only the new code contains.
- Release flow: bump package.json, add a CHANGELOG entry (newest first, same voice), build,
  install and TEST it, commit, push, `gh auth switch --user taipeiviking`, `gh release create
  vX.Y.Z <installer> --repo taipeiviking/MultiMCP --title ... --notes ...`, switch back.
- Docs to keep in sync: README.md, HELP.md, SPEC.md, CHANGELOG.md, docs/ADD_ACCOUNT.md,
  docs/SWITCH_CLAUDE_BUILD.md. Keep download links version-AGNOSTIC (/releases/latest).

## Known open items

- The other desktop PC still needs updating to v0.5.1.
- Claude Desktop on my machines is still the Microsoft Store (sandboxed) build. Switching to the
  installer build from claude.ai/download was proposed as a fix for intermittent "Server
  disconnected" banners — still an UNTESTED hypothesis. Guide: docs/SWITCH_CLAUDE_BUILD.md.
- An 11.6 GB backup folder "Claude-AppData-Backup-2026-07-14" is on my Desktop; deletable once
  I'm confident everything works.
- `uvx workspace-mcp` is unpinned, so an upstream release lands on the next cold cache. Pinning is
  tempting, BUT prewarm()/testServer() warm `uvx workspace-mcp` — if the pinned args diverge from
  what prewarm warms, Claude's first spawn does a ~90-package install during attach and times out.
- The token guard is REPAIR, not prevention. A genuine fix would need workspace-mcp to write token
  files atomically (upstream), or each client to get its own credentials dir (bigger change:
  sign-ins would need syncing between them).
- Never-built ideas I've declined: an MSI target, a "Copy account list for Claude" button,
  SIGNING.md for a real code-signing cert, a guard on "Write config" when the engine is missing.

## How I like to work

Work autonomously, but pause for: GitHub web actions, anything involving secrets, real decisions,
and public releases. Version bump -> rebuild -> actually test the INSTALLED app -> then publish.
Tell me plainly when something didn't work; don't dress it up.
```
