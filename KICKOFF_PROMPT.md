# Claude Code — Project Kickoff Prompt: MultiMCP (Google Workspace Manager)

Paste everything below the line into Claude Code from inside `C:\Users\class\git\MultiMCP`.

---

You are my engineering partner for this project. Work autonomously through the plan below, but pause and ask me when a step genuinely requires my input (GitHub web actions, secrets, decisions). I'm on Windows 11, PowerShell, with `uv`/`uvx` and Node.js installed. Keep me oriented with short status notes as you go.

## What this project is
A local Windows desktop app (Electron + React) that connects **5 Google Workspace accounts across different domains** to Claude Desktop for Gmail, Drive, and Calendar. It does NOT reimplement an MCP server — it's a control panel that **wraps the proven `workspace-mcp`** (https://github.com/taylorwilsdon/google_workspace_mcp). The app owns credentials, per-account OAuth sign-in, status, and writing the Claude Desktop config. A scaffold already exists in this folder.

**Read `SPEC.md` and `README.md` first — `SPEC.md` is the authoritative design.** Honor the architecture in it (one OAuth client, one shared `GOOGLE_MCP_CREDENTIALS_DIR`, many accounts; the stdio server Claude Desktop launches reuses tokens the app primes).

## Part A — Set up git for my SECOND GitHub account (do this first)
This repo must use my `taipeiviking` GitHub account (https://github.com/taipeiviking) via an isolated SSH key, WITHOUT disturbing my other GitHub account or any global git config. My other Claude Code projects use a different account and must keep working.

Do the local work yourself:
1. Confirm whether `.git` exists; if not, `git init`.
2. If `%USERPROFILE%\.ssh\id_ed25519_taipeiviking` does not exist, create it:
   `ssh-keygen -t ed25519 -C "taipeiviking" -f $env:USERPROFILE\.ssh\id_ed25519_taipeiviking -N '""'`
3. **Append** (never overwrite) this block to `%USERPROFILE%\.ssh\config`, only if an identical `Host github-taipeiviking` block isn't already present:
   ```
   Host github-taipeiviking
       HostName github.com
       User git
       IdentityFile ~/.ssh/id_ed25519_taipeiviking
       IdentitiesOnly yes
   ```
4. Set repo-LOCAL identity only (do NOT touch `--global`): set `user.name` to `taipeiviking` and ask me for the email tied to that GitHub account, then set `user.email` locally.
5. Add the remote using the alias (not github.com):
   `git remote add origin git@github-taipeiviking:taipeiviking/MultiMCP.git`
   (use `set-url` if origin already exists).
6. Stage and commit everything as "Initial scaffold: Google Workspace Manager".

Then PAUSE and give me clear instructions for the two things only I can do:
- Print my public key (`Get-Content $env:USERPROFILE\.ssh\id_ed25519_taipeiviking.pub`) and tell me to add it to taipeiviking → Settings → SSH and GPG keys.
- Tell me to create an EMPTY repo named `MultiMCP` under taipeiviking (no README/.gitignore).

After I confirm both are done: verify with `ssh -T git@github-taipeiviking` (expect a greeting as taipeiviking), then `git branch -M main` and `git push -u origin main`. Confirm the push targeted taipeiviking, not my other account.

## Part B — Finish the Google Cloud setup (guide + verify)
My project already has: an OAuth client (Web application, Client ID `605255500601-sqnp5ppvjrg2tl50usnb6u4g2bcp0qpi.apps.googleusercontent.com`), and these APIs enabled: Gmail API, Google Drive API, plus the Gmail/Drive/Calendar **MCP** preview APIs. Still outstanding — walk me through each and confirm:
1. Enable the **standard Google Calendar API** (`calendar-json.googleapis.com`) — `workspace-mcp` uses the standard APIs, not the `*mcp.googleapis.com` ones.
2. OAuth consent screen: Audience = **External**, with all 5 of my Workspace account emails added as **Test users**.
3. On the OAuth client, add redirect URI `http://localhost:8000/oauth2callback` (keep the existing `https://claude.ai/api/mcp/auth_callback` too).

Do NOT put the OAuth **client secret** in any file or prompt. It is entered once in the app UI and stored in Windows Credential Manager (keytar). The only documented exception is the secret injected into `claude_desktop_config.json` at write time per SPEC §9 — flag that to me before doing it.

## Part C — Complete the scaffold
Implement the `TODO(claude-code)` items, in the build order from `SPEC.md` §11. The two that must be confirmed against the live `workspace-mcp`:
- `electron/services/serverManager.js` → `authorizeAccount(email)`: finalize the real per-account OAuth initiation (launch a transient `uvx workspace-mcp --transport streamable-http` instance with the shared env, open the system browser to the correct authorize URL with a `login_hint` for the target account, detect completion, stop the transient server).
- `electron/services/accounts.js` → `readTokenStatus(email)`: confirm `workspace-mcp`'s on-disk credential filename and JSON shape in `GOOGLE_MCP_CREDENTIALS_DIR`, and parse real token expiry for the countdown.
Run the actual server locally to discover these details rather than guessing; then fill in, and keep the Electron security posture (contextIsolation, sandbox, no nodeIntegration, system browser for OAuth).

## Part D — Build, run, verify
- `npm install`, then `npm run rebuild` (rebuild keytar for Electron), then `npm run dev`.
- End-to-end test: save credentials → add one account → sign in → see it green with an expiry → write the Claude Desktop config → restart Claude Desktop → confirm it can read that account's Gmail/Calendar/Drive. Then repeat for all 5 accounts.
- When stable: `npm run dist` to produce the Windows installer.

## Known constraints (don't try to "fix" these)
- Google expires refresh tokens ~every 7 days while the OAuth app is in "Testing" status. The app makes re-auth one click; it cannot remove the limit without publishing + Google verification.
- Local only. No telemetry. Least-privilege: keep the `--tools gmail drive calendar` scope.

## Working style
- Commit in logical steps with clear messages; push to taipeiviking.
- Update `SPEC.md` if the design changes, and add a brief `GIT_SETUP.md` recording the account/alias used so future sessions remember.
- Ask before any destructive action or anything that changes my global git or other repos.
