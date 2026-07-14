# Switch Claude Desktop: Microsoft Store → Installer build

**Why:** the Microsoft Store version of Claude Desktop is sandboxed, which is the likely
cause of the recurring **“MCP … Server disconnected”** banner. The installer build runs
Claude as a normal (non-sandboxed) app **and auto-updates itself** — no Microsoft Store
involved.

> Note on the name: from **v0.4.0** the connector appears in Claude as **MultiMCP**. It used
> to be called `google_workspace`, which is the name you will still see if the tray app on
> that PC has not been updated yet. When the new version writes its entry it deletes the old
> one, so you will not end up with two connectors.

**Good news before you start:**
- Your **MultiMCP** setup **carries over** — you do **not** need to re-auth, re-import, or
  reconfigure anything. Installing Claude does replace Claude's own config file, but the
  Google Workspace Manager app puts its entry back for you (see Step 4).
- Your data is **safe**. Even more important: your **accounts and sign-ins do NOT live in
  Claude's folder at all** — they're in the Google Workspace Manager app's own data:
    - `C:\Users\<you>\AppData\Roaming\google-workspace-manager\` (settings + account list)
    - `C:\Users\<you>\.google_workspace_mcp\credentials\` (the per-account sign-in tokens)
    - Windows **Credential Manager** (the OAuth secret)
    - plus your exported `…backup-YYYY-MM-DD.json`
  Claude's own config lives at `C:\Users\<you>\AppData\Roaming\Claude\` (this is what
  `%APPDATA%\Claude` expands to — note `%APPDATA%` only expands in PowerShell / File
  Explorer's address bar, not in a plain search box). The installer build reads that same
  folder. Worst case, click **Write config** in the app and it rebuilds the MultiMCP entry
  from scratch.
- Do the steps **in this order** (uninstall Store first, then install), so two copies of
  Claude don’t fight over the MCP server (port 9000) during the switch.

> Snapshot from the day this guide was written (kept only as an example of the starting
> point): Store build = **Claude 1.20186.7.0**, installer build = *not yet installed*, both
> config files present and in sync. Check your own machine rather than trusting these numbers.

---

## Step 1 — Fully close Claude Desktop

Right‑click the **Claude icon in the system tray** (click the `^` chevron if hidden) →
**Quit**. Closing the window is **not** enough.

> Note: this does **not** affect *Claude Code* (a separate program) — leave it running.

---

## Step 2 — Uninstall the Microsoft Store version

Pick **one** method:

**A) Settings (simplest):**
Settings → **Apps** → **Installed apps** → **Claude** → **⋯** → **Uninstall**.

**B) PowerShell (precise):**
```powershell
Get-AppxPackage -Name '*Claude*' | Remove-AppxPackage
```

✔️ This removes only the sandboxed copy under
`C:\Users\<you>\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\…`. Your regular Claude config
folder `C:\Users\<you>\AppData\Roaming\Claude\` — and all your Google Workspace Manager
data — stays put.

---

## Step 3 — Install the regular (installer) build

1. Open **https://claude.ai/download**
2. Download the **Windows** installer — the direct **`.exe`** (e.g. `Claude-Setup-x64.exe`).
   - ⚠️ **Do NOT** click any “Get it from the Microsoft Store” button — that’s the one
     you’re leaving.
3. Run the `.exe`. It installs to `%LOCALAPPDATA%\AnthropicClaude\`.
   - If Windows **SmartScreen** shows *“Windows protected your PC”* →
     **More info → Run anyway** (normal for a downloaded installer).

---

## Step 4 — Re‑wire and verify

Installing Claude Desktop **replaces** its config file (`claude_desktop_config.json`), which
silently removes the connector. That is expected, and you do not have to fix it by hand:
since **v0.3.9** the app notices and **re‑adds its entry automatically** every time it
starts, on any PC where it has written one before. So simply starting the tray app is
enough.

1. Open **Google Workspace Manager** (the tray app) and leave it to do its thing — it puts
   the **MultiMCP** entry back into `%APPDATA%\Claude`, which the installer build reads.
   (If you want to be certain, click **Write config** to force a rewrite.)
2. Launch the **new** Claude Desktop, then **fully Quit it once** (tray → Quit) and reopen.
   Claude only reads its MCP config at startup, so this step is not optional.
3. In a new chat: **+ (plus)** → **Connectors** → confirm **`MultiMCP`** is listed.
4. Test it: ask Claude *“using MultiMCP, list my Gmail labels.”* If it returns results,
   you’re done.

> The same thing applies any time you reinstall or repair Claude Desktop in future: start
> Google Workspace Manager, then fully quit and reopen Claude.

---

## How updates work now (the point of switching)

The installer build has a **built‑in auto‑updater**: it checks Anthropic’s servers on
launch / periodically and updates **itself** silently. No Microsoft Store, no manual
reinstalls, no sandbox.

---

## Optional — catch any future disconnect live

If the banner ever comes back, enable Claude’s in‑app DevTools to see the real error:

```powershell
'{"allowDevTools": true}' | Set-Content "$env:APPDATA\Claude\developer_settings.json"
```
Then in Claude press **Ctrl+Alt+I** → **Console** tab. (Do this on the **installer** build,
not the Store one.)

---

## Quick checklist

- [ ] Step 1 — Quit Claude from the tray (not just the window)
- [ ] Step 2 — Uninstall the Store version (Settings, or `Remove-AppxPackage`)
- [ ] Step 3 — Install the `.exe` from https://claude.ai/download (NOT the Store)
- [ ] Step 4 — Start Google Workspace Manager → fully Quit + reopen new Claude → verify
      `MultiMCP`
- [ ] (Optional) enable DevTools

---

## If something looks off

- **Setup screen appears in Google Workspace Manager** → on older versions this was a real
  bug: the settings file could be left truncated by an unclean shutdown or a restart, and the
  app would then quietly overwrite it, losing your Client ID for good. **v0.3.9 fixes it
  properly** — settings are now written atomically and kept with a backup, and a damaged file
  is repaired from that backup on the next launch. (v0.3.8 had blamed something else and only
  treated the symptom, so if you are on v0.3.8 or older, update.) If you do land on the setup
  screen and the app tells you your settings appear to have been lost, use **Import** with
  your exported `…backup-YYYY-MM-DD.json`.
- **The connector has vanished from Claude** (typically right after reinstalling or repairing
  Claude Desktop, which replaces its config file) → just start **Google Workspace Manager**,
  then fully quit and reopen Claude. Since v0.3.9 the app re‑adds its entry on launch.
- **Claude lists a `google_workspace` connector instead of `MultiMCP`** → you are on an older
  version of the app. Update to v0.4.0 or later and start it; it renames the entry and removes
  the old one, so you will not end up with both.
- **“Could not attach to MCP server”** (cold start after an update) → reopen Claude once
  more; the first attempt finishes the background install.
- **Still disconnecting on the installer build** → note when it happens (after sleep? after
  quit?) and look in `%APPDATA%\Claude\logs\`. Claude names each MCP log after the connector,
  so the file you want is the one for **MultiMCP** (on machines still running the old version,
  it is the `google_workspace` one).

*Ref: MCP debugging guide — https://modelcontextprotocol.io/docs/tools/debugging*
