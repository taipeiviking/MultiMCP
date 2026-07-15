# Paste-ready prompt — update MultiMCP on the desktop (or any dev machine)

Copy everything inside the fence into a new Claude session on the desktop, with the
working folder set to the MultiMCP repo. (Written 2026-07-15, current release **v0.8.1**.)

This is the companion to [`LAPTOP_HANDOFF.md`](LAPTOP_HANDOFF.md): that one is for a
secondary/consumer machine; this one is for the machine where development normally happens
but which, for a given release, only needs to *consume* what was already built and released
elsewhere. Bump the version in the fence when you cut a newer release.

---

```
You are helping me update MultiMCP on my desktop to the latest release (v0.8.1). This machine
is where I normally develop MultiMCP, but v0.8.1 has ALREADY been built, pushed to main, and
released from my laptop — so on this side you are just consuming it: pull, install, verify. Do
NOT cut another release. Read this whole brief before touching anything.

## What MultiMCP is
A Windows Electron tray app, shipped as "Google Workspace Manager", that connects several Google
Workspace accounts to AI clients (Claude Desktop AND ChatGPT Codex) as one MCP connector for
Gmail / Drive / Calendar. It wraps the Python `workspace-mcp` server via a bundled `uvx`.
- Repo: https://github.com/taipeiviking/MultiMCP (public)
- Local checkout: C:\Users\class\git\MultiMCP (confirm; adjust if different)
- Latest release: v0.8.1. Installer: Google-Workspace-Manager-Setup-0.8.1.exe
- 5 accounts: clas@assaya.com, clas@advoli.com, clas@liquacool.com,
  clas.sivertsen@gmail.com ("Personal"), cs@apollo.bio

## What's new in v0.8.1 (why you're updating)
The ChatGPT Codex config service now cleans up the OLD `google_workspace` connector entry when it
writes the new `MultiMCP` one — the same legacy-key cleanup the Claude side already had. Before
this, a `~/.codex/config.toml` that still held `[mcp_servers.google_workspace]` (from a pre-rename
build) made Codex spawn BOTH Workspace servers, and the old one lacked the OAuth-tab fix
(MCP_SINGLE_USER_MODE + the no-op BROWSER shim), so it still threw a Google sign-in tab on the
second account. v0.8.1 strips the legacy entry and AUTO-MIGRATES it on launch. If this desktop's
Codex config still has that stale entry, launching v0.8.1 fixes it automatically.

## YOUR TASK (in order)
1. Confirm you're in C:\Users\class\git\MultiMCP and it IS the MultiMCP repo (git remote =
   taipeiviking/MultiMCP), NOT the parent folder (see guardrails). Then `git pull --ff-only` on
   main. Expect HEAD at commit `574c774` ("release: v0.8.1"), clean. If the pull will NOT
   fast-forward because this desktop has local commits on main that were never pushed, STOP and
   show me the divergence — do not force, rebase, or reset. We reconcile deliberately.
2. Check the CURRENTLY INSTALLED version from the log:
   %APPDATA%\google-workspace-manager\logs\app.log (look for `app ready ... "version"`). If it's
   already 0.8.1, skip to step 5.
3. Update to v0.8.1: download the installer from
   https://github.com/taipeiviking/MultiMCP/releases/latest
   (Google-Workspace-Manager-Setup-0.8.1.exe), verify its SHA256 against the release digest,
   stop any running copy of the tray app BY PID (confirm it's gone), then run the installer
   silently (/S). Confirm the installed app.exe reports 0.8.1 before continuing. (You may build
   locally with `npm run dist` instead, but the published installer is the tested one; if you do
   build, `npm install` first — the lockfile added `smol-toml`.)
4. Launch "Google Workspace Manager" and leave it running. On launch it rewrites the Claude
   Desktop connector to `MultiMCP`, and — new in v0.8.1 — migrates any stale Codex
   `google_workspace` entry to `MultiMCP`. Confirm from app.log:
   `codex config auto-healed ... renamed "google_workspace" -> "MultiMCP"` (if a stale entry was
   present) and a final `codex:status ... present:true, inSync:true, legacyKey:null`. Also confirm
   `claude:status ... inSync:true`. If the app opens on the first-run SETUP screen, settings were
   lost — recover via "Import configuration from a file…" with my exported backup .json (there's
   one in Downloads named google-workspace-manager-backup-*.json); tell me if you can't find one.
5. Fully QUIT Claude Desktop (tray icon → Quit — NOT just closing the window) and reopen it. NOTE:
   on my machines the Claude Code session you're running in is a CHILD of the Claude Desktop
   process — so quitting Claude Desktop may close the window you're reading this in. Do NOT kill
   Claude Desktop yourself; ask me to do the quit+reopen, then continue.
6. Restart ChatGPT/Codex too, so it drops the old in-memory server and loads the migrated config.
7. Verify (these are CLIENT tests — do NOT call the Google MCP tools yourself; that's what used to
   open tabs): in Claude Desktop, the connector list shows `MultiMCP`; in ONE conversation ask it
   to check mail across TWO accounts — expect zero browser tabs. Then the same in Codex (not an
   ordinary ChatGPT chat — those can't use local MCP).
8. Report what you found before changing anything else.

## HARD GUARDRAILS — read twice
1. GIT ISOLATION. C:\Users\class\git is ITSELF a different repo (taipeiviking/www.liquacool.com),
   and MultiMCP is nested inside it; there may be sibling repos with dirty trees. ONLY run git
   against C:\Users\class\git\MultiMCP. NEVER against the parent or a sibling. Git identity is
   repo-LOCAL (user.name=taipeiviking). NEVER `git config --global`.
2. TWO GITHUB ACCOUNTS. `gh` has classivertsen (active by default) and taipeiviking (owns
   MultiMCP). You're only pulling/installing — no push, no release, nothing that needs a switch.
   Pushing/publishing over SSH authenticates as taipeiviking with no gh switch; `gh` API actions
   (releases) would need `gh auth switch --user taipeiviking` then IMMEDIATELY switch back — but
   you should NOT be doing any of that this time (v0.8.1 is already released).
3. NEVER kill processes by name — always by PID, and CONFIRM the tray app is gone before
   relaunching.
4. NEVER call the MultiMCP / google_workspace MCP tools just to "test" auth — that opened real
   browser tabs. To exercise the server, spawn your OWN copy over stdio with BROWSER pointed at the
   no-op shim (%LOCALAPPDATA%\MultiMCP\no-browser.cmd) and a COPY of the credentials dir.
5. Never put the OAuth client secret in a file you create, a commit, or chat. It lives in Windows
   Credential Manager and is injected into the client configs by design — don't print/copy it.
6. Ask me before anything destructive, anything touching global git config or other repos, and
   before any publish/release.

## How I like to work
Work autonomously, but pause for: GitHub web actions, secrets, real decisions, and public
releases. Tell me plainly when something didn't work; don't dress it up.
```
