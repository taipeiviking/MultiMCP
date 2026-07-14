# Switch Claude Desktop: Microsoft Store → Installer build

**Why:** the Microsoft Store version of Claude Desktop is sandboxed, which is the likely
cause of the recurring **“MCP google_workspace: Server disconnected”** banner. The
installer build runs Claude as a normal (non-sandboxed) app **and auto-updates itself** —
no Microsoft Store involved.

**Good news before you start:**
- Your `google_workspace` setup **carries over** — both config files already match, so you
  do **not** need to re-auth, re-import, or reconfigure anything.
- Your data is **safe**: your real config + tokens live at `%APPDATA%\Claude\` and in
  Windows Credential Manager — **outside** the Store sandbox — so uninstalling the Store
  app does not touch them.
- Do the steps **in this order** (uninstall Store first, then install), so two copies of
  Claude don’t fight over the MCP server (port 9000) during the switch.

> This computer right now: Store build = **Claude 1.20186.7.0**, installer build = *not yet
> installed*, both config files present and in sync.

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
`…\Packages\Claude_pzs8sxrjxfjjc\…`. Your `%APPDATA%\Claude\` config stays put.

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

1. Open **Google Workspace Manager** (the tray app) → click **Write config**.
   (Re‑confirms the `google_workspace` entry at `%APPDATA%\Claude`, which the installer
   build reads.)
2. Launch the **new** Claude Desktop, then **fully Quit it once** (tray → Quit) and reopen.
   Claude only reads its MCP config at startup.
3. In a new chat: **+ (plus)** → **Connectors** → confirm **`google_workspace`** is listed.
4. Test it: ask Claude *“using google_workspace, list my Gmail labels.”* If it returns
   results, you’re done.

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
- [ ] Step 4 — Write config → fully Quit + reopen new Claude → verify `google_workspace`
- [ ] (Optional) enable DevTools

---

## If something looks off

- **Setup screen appears in Google Workspace Manager** → it’s a boot‑timing thing; fully
  quit + reopen the tray app. Your data isn’t lost (v0.3.8 fixes this).
- **“Could not attach to MCP server”** (cold start after an update) → reopen Claude once
  more; the first attempt finishes the background install.
- **Still disconnecting on the installer build** → note when it happens (after sleep? after
  quit?) and check `%APPDATA%\Claude\logs\mcp-server-google_workspace.log`.

*Ref: MCP debugging guide — https://modelcontextprotocol.io/docs/tools/debugging*
