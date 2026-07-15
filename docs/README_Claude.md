# Using MultiMCP with Claude Desktop

*Connect your Google Workspace accounts — Gmail, Drive, and Calendar — to Claude Desktop, so you can ask Claude about your mail, files, and calendar in any chat.*

This guide is for **Claude Desktop** specifically. If you use OpenAI's Codex instead, see the [Connecting to OpenAI Codex](../README.md#-connecting-to-openai-codex) section of the main README — the two can share the same sign-ins.

---

## What you get

Once this is set up, Claude Desktop gains a connector called **MultiMCP** that lets Claude reach your Google Workspace accounts on your behalf. In a normal chat you can ask Claude to:

- **Gmail** — search your inbox, read messages and threads, list your labels, and pull details out of mail.
- **Drive** — search for files, open a document's contents, and find things you've stored.
- **Calendar** — list your calendars and see what's coming up.

You can connect **several Google accounts at once** (across different domains) and tell Claude which one to use for each request. Everything runs locally on your PC — there is no cloud service in the middle. The data path is simply: your PC → Google's APIs.

> **Read-and-search, with your accounts primed by you.** MultiMCP exposes the Gmail, Drive, and Calendar tools from the open-source [`workspace-mcp`](https://github.com/taylorwilsdon/google_workspace_mcp) server. You do every sign-in yourself, in the tray app; Claude only ever uses the accounts you have already signed in.

---

## Prerequisites

Before you start, you need three things:

1. **Claude Desktop**, installed on Windows. If you don't have it, download it from <https://claude.ai/download>.
2. **Windows 10 or 11.**
3. **A Google Cloud OAuth client** (one Client ID + Secret, shared by all your accounts). Setting this up in the Google Cloud Console is a one-time job. The full, illustrated walkthrough — enabling the Gmail/Drive/Calendar APIs, creating the OAuth client, and adding your accounts — is in **[docs/ADD_ACCOUNT.md](ADD_ACCOUNT.md)**. Come back here once you have your Client ID and Secret in hand.

You do **not** need to install Python or the `uv`/`uvx` engine separately — the engine is bundled inside the installer.

---

## Step 1 — Install the tray app

1. Open the **[latest release page](https://github.com/taipeiviking/MultiMCP/releases/latest)**.
2. Under **Assets**, download **`Google-Workspace-Manager-Setup-<version>.exe`** (take the newest release — the version number in the filename changes each time).
3. Run it. If Windows **SmartScreen** shows a one-time *"Windows protected your PC"* notice, click **More info → Run anyway**. This is normal for an app that isn't signed with a paid certificate; it installs per-user and needs no admin rights.
4. Launch the app. It lives in the **system tray** (an amber dot — click the `^` chevron if it's hidden). The footer should read **"Engine ready (bundled)"**.

---

## Step 2 — First-run configuration

The very first screen asks you to connect your Google OAuth client. You have two ways in:

- **Type your Client ID and Secret** (from your Google Cloud project) into the fields and save. The secret is stored securely in **Windows Credential Manager**, not in a plain file.
- **Import a configuration file** — if you've already set MultiMCP up on another PC, click **📥 Import configuration from a file…** and pick the `.json` you exported there. This brings your Client ID, Secret, account list, and sign-ins across so you don't have to redo anything. (See [Moving to another computer](../HELP.md#export-import) in HELP.md.)

---

## Step 3 — Add your accounts and sign in

For each Google account you want Claude to reach:

1. Type the email into the **add account** box and click **Add**. A grey *not connected* card appears.
2. Click **Sign in**. Your **system browser** opens to Google.
3. If you see **"Google hasn't verified this app"**, that's expected for a personal/team OAuth app — click **Advanced → Go to … (unsafe)**. It's your own app.
4. Confirm the right account and **grant all** the Gmail, Drive, and Calendar permissions. (Partial grants cause "missing scopes" errors later.)
5. The browser shows **"Authentication Successful."** Back in the app, the card turns **🟢 green**.

Repeat for every account. You can add as many as you like — one OAuth client serves all of them, and each account gets its own saved sign-in.

---

## Step 4 — The key step: Write config, then fully quit and reopen Claude

This is the one part people trip over, so it's worth doing carefully.

1. On the dashboard, find the **Claude Desktop** config strip and click **Write config**. The app finds Claude's `claude_desktop_config.json` (at `%APPDATA%\Claude\claude_desktop_config.json`), **backs it up**, and **merges in** a `MultiMCP` server entry — it never touches your other MCP servers. The strip then reads **"Claude Desktop config in sync."**
2. **Fully quit Claude Desktop** — use **Quit** from Claude's own tray/menu, **not** just closing the window.
3. **Reopen Claude Desktop.**

### Why a full quit is required

**Claude Desktop only reads its config file at startup.** If you merely close the window, Claude keeps running in the background with the config it loaded earlier — so it won't see the new connector, or it will still show the old name. Only a genuine **Quit → reopen** makes Claude re-read the file and pick up MultiMCP. Until you do that, the connector simply won't appear.

---

## Step 5 — Find it in Claude

In a new chat, open Claude's **connectors / tools** menu. You should see **`MultiMCP`** listed, with the Gmail, Drive, and Calendar tools underneath it.

> **If it's called `google_workspace`:** on older versions (before v0.4.0) the connector was named `google_workspace`. The app now renames it to **MultiMCP** automatically — the name Claude shows is just the key in the config file. If you ever see the old name, it means Claude is still running the old config; fully quit and reopen it once more.

---

## How to actually use it in a chat

You don't call tools directly — you just ask Claude in plain language, and Claude picks the right tool. The one thing to remember: **because several accounts are connected, you usually have to tell Claude _which_ account to use.** Name the email in your request (this is the `user_google_email` the tools need). Here are prompts you can type more or less as-is:

- *"Search my `clas@liquacool.com` Gmail for messages about the Q3 invoice and summarise what they say."*
- *"List the Gmail labels on my `clas@assaya.com` account."*
- *"Look through my unread mail from the last 3 days across `clas@liquacool.com` and `clas@assaya.com`, and give me a short summary of anything that needs a reply."*
- *"What's on my calendar next week for `clas@liquacool.com`?"*
- *"Find the latest contract PDF in my `clas@assaya.com` Drive and tell me what it's about."*
- *"Show me the events on `clas@liquacool.com`'s calendar for tomorrow, and check whether any of them overlap."*

Behind the scenes Claude uses tools such as `search_gmail_messages`, `list_gmail_labels`, `get_gmail_message_content`, `search_drive_files`, `get_drive_file_content`, `list_calendars`, and `get_events`. You never type those names — Claude selects them from your request. If you leave out the account and Claude asks which one, just tell it the email.

> **Tip: label your accounts so you can skip the email.** Each account card has a short, editable **label** — click **+ label** on the account row, type something like *Personal* or *Work*, and press **Enter**. On its own the label is just a note to you; clicking **Add usage rules…** is what folds the label→account mapping into the guidance Claude sees (the connected-accounts line then reads like *"clas.sivertsen@gmail.com (Personal), clas@liquacool.com (Work)"*). After that you can say *"check my personal email"* instead of typing the full address, and Claude maps it to the right account.

> **The first call may be slow.** The very first time Claude uses MultiMCP after a restart, it can take a little while as `uvx` warms up and provisions the server in the background. That's expected, not a hang — later calls are fast. (Keeping the tray app open helps here: it pre-warms the engine so this happens off Claude's critical path.)

---

## Verifying it works

Two quick checks:

1. **The connector shows up.** Open the connectors / tools menu in a new chat and confirm **MultiMCP** is listed with Gmail/Drive/Calendar tools.
2. **A simple read works — with no browser tabs.** Ask: *"List my Gmail labels for `clas@liquacool.com`."* You should get a list of labels back, and **no Google sign-in tab should open**. (If a sign-in tab does pop up, see the troubleshooting note below — you're on a version before the fix.)

---

## Do I have to keep the tray app running?

No — but it's a good idea. Claude launches its **own** copy of the server for each chat session, pointed at the same shared credentials, so the connector works even when the tray app is closed. What the tray app adds by staying open (in the system tray) is the **self-healing**: it re-checks and repairs the config, keeps your sign-ins verified, warns you before a token expires, and pre-warms the engine. Tick **Start with Windows** to keep it in the tray on login.

---

## Troubleshooting (Claude-specific)

**The connector doesn't show up in Claude.**
Almost always this means Claude wasn't fully restarted. Confirm the app's strip says **in sync**, then **Quit** Claude from its tray/menu (not just close the window) and reopen it. Claude reads its config only at startup. You can also check Claude's own logs at `%APPDATA%\Claude\logs\`.

**The name reverted to `google_workspace` on its own (and the sign-in tabs came back).**
Claude Desktop doesn't only *read* its config file — it also *writes* it, saving back the connector list it loaded when Claude started. So a still-running Claude could quietly put the old `google_workspace` entry back. Since **v0.5.1** the tray app **watches the config file and repairs it within a second or two** of any outside change, so the order in which you restart things no longer matters. The fix: keep the **tray app running**, and make sure you're on the latest version.

**A Google sign-in tab opens (often "Access blocked" / "Error 400: redirect_uri_mismatch").**
This was a real bug, **fixed in v0.4.0** and hardened since. It fired as soon as a single conversation used more than one account. **Update to the latest release**, then fully quit and reopen Claude so it loads the fixed connector entry. After the fix, an account that genuinely needs re-signing produces a **Windows notification** from the tray app (click it → **Re-auth** on that account) rather than a browser tab.

**"Could not attach to MCP server MultiMCP."**
A cold-start timeout: the first time a new `workspace-mcp` version runs, `uvx` installs it (~90 packages), which can exceed Claude's attach timeout. Keep the tray app running so it pre-warms the engine, and **reopen Claude once more** — the failed attempt finishes the install, so the next one is fast.

**"MCP MultiMCP: Server disconnected."**
Usually **not** a real failure — Claude shows this after the PC sleeps, or after Claude was quit/updated, and the server re-spawns fine on the next request (check the connectors menu; the tools are still there). If it's **persistent**, the most common cause is running the **Microsoft Store** build of Claude Desktop, whose sandboxing is less reliable for long-lived local MCP servers. Switching to the regular **installer** build usually resolves it — step-by-step in **[docs/SWITCH_CLAUDE_BUILD.md](SWITCH_CLAUDE_BUILD.md)**.

**An account shows "re-auth needed."**
Open the dashboard, find that account, and click **Re-auth** — it opens a real browser sign-in from the app. (While your OAuth app is still in Google's *Testing* mode, sign-ins expire about every 7 days; publishing to production removes that — see [Make sign-ins long-lived](../HELP.md#long-lived).)

For the complete troubleshooting list, see **[HELP.md → Troubleshooting](../HELP.md#troubleshooting)**.

---

## Removing it

To disconnect MultiMCP from Claude Desktop:

- **Simplest:** in the tray app, or by hand, remove the connector and restart Claude. To do it by hand, open `%APPDATA%\Claude\claude_desktop_config.json` in a text editor, delete the **`MultiMCP`** block under `mcpServers` (on a config last written before v0.4.0 it's called `google_workspace`), save, and **fully quit and reopen** Claude.
- **Note:** if the tray app is still installed and running, it will **put its entry back** (that's the self-healing). To remove it for good, delete the entry **after** uninstalling the tray app — or just leave it in place, since a connector Claude never calls costs you nothing.
- **Full uninstall:** remove the app from Windows **Settings → Apps**, then follow the clean-up list in **[HELP.md → Uninstalling](../HELP.md#uninstalling)** to delete the leftover credentials and settings.

---

*MultiMCP wraps the open-source [`workspace-mcp`](https://github.com/taylorwilsdon/google_workspace_mcp) server. Local-only, least-privilege (`--tools gmail drive calendar`). For the full end-user manual, see [HELP.md](../HELP.md); for what changed in each version, see [CHANGELOG.md](../CHANGELOG.md).*
