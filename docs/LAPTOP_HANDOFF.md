# Paste-ready prompt — update MultiMCP on another computer

Copy everything inside the fence into a new Claude session on the laptop, with the
working folder set to the MultiMCP repo. (Written 2026-07-15, current release **v0.8.0**.)

---

```
You are helping me update MultiMCP on my laptop. The main development happens on my
desktop; this laptop just needs to be brought up to the latest. Read this whole brief
before touching anything.

## What MultiMCP is

A Windows Electron tray app, shipped as "Google Workspace Manager", that connects several
Google Workspace accounts to AI clients (Claude Desktop AND ChatGPT Codex) as one MCP
connector for Gmail / Drive / Calendar. It wraps the Python `workspace-mcp` server, run
through a bundled `uvx`.

- Repo: https://github.com/taipeiviking/MultiMCP  (public)
- Local checkout on this laptop: C:\Users\class\git\MultiMCP  (confirm; adjust if different)
- Current release: v0.8.0 — installer attached to the GitHub release.
- 5 accounts are connected on my machines: clas@assaya.com, clas@advoli.com,
  clas@liquacool.com, clas.sivertsen@gmail.com (labelled "Personal"), cs@apollo.bio

## YOUR TASK (in order)

1. Confirm you're in C:\Users\class\git\MultiMCP and it IS the MultiMCP repo — NOT the
   parent folder (see guardrails). Then `git pull` on `main`. Expect HEAD at or after
   commit `aef1ca2` (v0.8.0), clean.
2. Update the app to v0.8.0: download the installer from
   https://github.com/taipeiviking/MultiMCP/releases/latest
   (Google-Workspace-Manager-Setup-0.8.0.exe) and run it. It closes any running copy of
   the tray app itself. (Alternatively build locally with `npm run dist` — see build
   notes — but the published installer is the tested one.)
3. Launch "Google Workspace Manager" and leave it running. On launch it: rewrites the
   Claude Desktop connector entry to `MultiMCP` (with the OAuth-tab fix), writes the
   ChatGPT Codex config if Codex is installed, starts the config + credentials watchers,
   and shadow-copies the token files. Confirm from the log:
   %APPDATA%\google-workspace-manager\logs\app.log
4. If the app opens on the first-run SETUP screen instead of the dashboard, my settings
   were lost on this machine (a pre-v0.3.9 bug). The screen now SAYS so — recover with
   "Import configuration from a file…" using my exported backup .json. Tell me if you
   can't find a backup.
5. Fully QUIT Claude Desktop (tray icon → Quit — NOT just closing the window; it keeps
   running in the background) and reopen it. This is the step everyone misses: a
   still-running Claude keeps its OLD MCP server and can still throw sign-in tabs.
6. Verify: Claude's connector list shows `MultiMCP` (not `google_workspace`). Then, in ONE
   conversation, ask Claude to check mail across TWO OR MORE accounts. Expect it to work
   with ZERO browser tabs. That's the regression test for the whole OAuth-tab fix.
7. Report what you found before changing anything else.

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
   back. Pushing over SSH needs no switch. (You probably won't publish from the laptop —
   just pull + install.)

3. NEVER kill processes by name — always by PID. And after stopping the tray app, CONFIRM
   it's gone before relaunching; a silently-failed kill has caused wasted test cycles.

4. NEVER call the MultiMCP / google_workspace MCP tools just to "test" an auth problem —
   that used to open real browser tabs. To exercise the server, spawn your OWN copy over
   stdio with BROWSER pointed at the no-op shim (%LOCALAPPDATA%\MultiMCP\no-browser.cmd)
   and use a COPY of the credentials dir.

5. Never put the OAuth client secret in a file you create, in a commit, or in chat. It
   lives in Windows Credential Manager (and is deliberately injected into the client
   configs — SPEC §9 — but don't print/copy it elsewhere).

6. Ask me before anything destructive, anything touching my global git config or other
   repos, and before publishing a public release.

## What has shipped (so you don't re-investigate solved problems)

- v0.3.9 — a PC reboot could truncate settings.json and the app then erased its own
  config. Fixed: atomic writes + rolling .bak + recovery; unreadable files never
  overwritten. This was the real cause of the recurring "not set up" screen.
- v0.4.0 — the connector opened Google sign-in tabs (Error 400: redirect_uri_mismatch)
  whenever a second account was used in one conversation. Root cause is upstream
  workspace-mcp (it binds the MCP session to the first account, immutably, then trips a
  swallowed ValueError for every later account -> false "not authenticated" ->
  webbrowser.open). Fixed with MCP_SINGLE_USER_MODE=1 (bypasses the binding; despite the
  name it does NOT limit you to one account) + a no-op BROWSER shim so the background
  server can't open a tab. Connector renamed google_workspace -> MultiMCP.
- v0.5.0 — "Write ChatGPT Codex config" button. Codex (CLI / IDE extension / Codex inside
  the ChatGPT desktop app) reads ~/.codex/config.toml; ordinary ChatGPT chats CANNOT use
  local MCP. Codex gets its own port (9001). config.toml is edited surgically (validate,
  backup, atomic, refuse-rather-than-guess).
- v0.5.1 — self-healing: watches both client config files and re-repairs them within ~1.5s
  (Claude Desktop rewrites its config and can resurrect the old entry); keeps shadow copies
  of token files and restores a clobbered one (two clients sharing one credentials dir can
  corrupt a token). Repair, not prevention.
- v0.6.0 — a "How to use in <client>" link on each card -> docs/README_Claude.md,
  docs/README_ChatGPT.md.
- v0.7.0 / v0.7.1 — "Add usage rules…" button: writes standing guidance telling the AI to
  use ONLY MultiMCP for Google Workspace and to always specify the account. Targets
  ~/.codex/AGENTS.md AND Codex's durable memory note (AGENTS.md alone didn't reliably
  stick), and ~/.claude/CLAUDE.md + a Claude Desktop copy box.
- v0.8.0 — account labels ("Personal", "Work") per account, folded into the usage-rules
  guidance so the AI resolves "my personal email" to the right account.

Ports, and they must stay this way: tray-app sign-in = 8000 (the ONLY redirect URI
registered in Google Cloud). Claude's background server = 9000. Codex's = 9001. 9000 and
9001 are DELIBERATELY unregistered — a safety interlock. Do NOT register them.

## Building locally (only if you don't use the published installer)

- `npm run dist` -> dist\Google-Workspace-Manager-Setup-<version>.exe (~90 MB).
- KNOWN Windows build failure without elevation: electron-builder fails extracting
  winCodeSign ("Cannot create symbolic link ... darwin/.../libcrypto.dylib"). Those macOS
  symlinks are irrelevant to a Windows build. Fix without elevating: extract a cached
  winCodeSign .7z into %LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0
  excluding darwin (7za x -bd -y "-o<dest>" <cache>.7z "-xr!darwin"), then rebuild.
- ALWAYS confirm the new build actually INSTALLED before testing (check the installed
  app.asar timestamp, or grep it for a string only the new code contains). A
  silently-failed Stop-Process once meant testing the OLD build.

## Known open items

- Claude Desktop on my machines is the Microsoft Store (sandboxed) build. Switching to the
  installer build from claude.ai/download was proposed for the intermittent "Server
  disconnected" banners — still an UNTESTED hypothesis. Guide: docs/SWITCH_CLAUDE_BUILD.md.
- An ~11.6 GB backup folder "Claude-AppData-Backup-2026-07-14" is on my desktop's Desktop;
  deletable once everything's confirmed good.
- After updating, if I want the "usage rules" active on the laptop too: label the accounts
  and click "Add usage rules…" on each card, then Apply.

## How I like to work

Work autonomously, but pause for: GitHub web actions, anything with secrets, real
decisions, and public releases. Version bump -> rebuild -> actually test the INSTALLED app
-> then publish. Tell me plainly when something didn't work; don't dress it up.
```
