# Using your Google Workspace accounts from ChatGPT Codex

> Connect Gmail, Drive, and Calendar for every Google account you've added to
> **MultiMCP** (the "Google Workspace Manager" tray app) straight into **ChatGPT
> Codex** — one click, and no signing anything in a second time.

---

## Read this first: which "ChatGPT" this works with

This is the part people get wrong, so it comes before everything else.

This connector works with **ChatGPT Codex** — specifically:

- ✅ the **Codex CLI**,
- ✅ the **Codex IDE extension** (VS Code and the like), and
- ✅ **Codex running inside the ChatGPT desktop app**.

All three read the same configuration file — `~/.codex/config.toml` — and all three
can talk to a **local** MCP server running on your PC. That is exactly what MultiMCP
is.

It does **not** work in **ordinary ChatGPT conversations** — not on chatgpt.com, and
not on the normal chat side of the ChatGPT desktop app. Those support only **remote**
MCP servers (reached over the network, using SSE or streamable HTTP). MultiMCP is a
**local (stdio)** server that runs on your own machine, so ChatGPT's chat interface
cannot reach it. This is a limitation of ChatGPT itself, and no setting in this app
changes it. If you want Google Workspace inside a plain ChatGPT chat, this tool is not
the way to get it.

The short version: **if you're using Codex, you're in the right place.** If you're
using the ChatGPT chat box, you're not.

---

## What you get

Once this is set up, a Codex session can read and work with the Google Workspace
accounts you've added to the tray app:

- **Gmail** — search messages, read them, list labels, and so on.
- **Drive** — search for files and read their contents.
- **Calendar** — list your calendars and read events.

You added each Google account **once**, in the tray app. From then on Codex simply
reuses those sign-ins — there is nothing to authorize again. If you use more than one
Google account (say a work domain and a personal Gmail), all of them are available in
the same Codex session; you just name which account you mean in your request.

---

## Prerequisites

1. **Windows 10 or 11.**
2. **ChatGPT Codex installed** — the CLI, the IDE extension, or the ChatGPT desktop
   app with Codex. Any one of them is enough; they all share the same config file.
3. **The tray app set up with at least one Google account.** That means you have a
   Google Cloud OAuth client (Client ID + Secret) and you've added and signed in each
   account. If you haven't done this yet, the illustrated walkthrough is in
   **[docs/ADD_ACCOUNT.md](ADD_ACCOUNT.md)** — it covers creating the one shared OAuth
   client and adding each account.

> **Already set this up for Claude Desktop?** Then you're almost done. The accounts,
> the sign-ins, and the OAuth client are **shared** — Codex reuses exactly the same
> ones. You do **not** re-add anything. Skip straight to
> [Step 3 — Write the ChatGPT Codex config](#step-3--write-the-chatgpt-codex-config).

---

## Step 1 — Install the tray app

1. Open the **[latest release](https://github.com/taipeiviking/MultiMCP/releases/latest)**
   and, under **Assets**, download **`Google-Workspace-Manager-Setup-<version>.exe`**
   (take the newest release; the version number in the filename changes each time).
2. Run it. If Windows **SmartScreen** shows a one-time *"Windows protected your PC"*
   notice, click **More info → Run anyway**. This is normal for an app without a paid
   code-signing certificate; it installs per-user, no admin needed.
3. Launch it. The **uv engine is bundled**, so there's nothing else to install.

---

## Step 2 — Configure and add your accounts (skip if you did this for Claude)

If the tray app is already set up (for Claude, or on another PC you imported from),
skip this step.

1. On first run, enter your Google OAuth **Client ID + Secret** once — or click
   **Import** to load a configuration file exported from another computer. The secret
   is stored in Windows Credential Manager, never in plaintext.
2. **Add** each Google account by email, then click **Sign in**. Your system browser
   opens to Google; grant **all** the Gmail / Drive / Calendar permissions (partial
   grants cause "missing scopes" errors later). Each account's card turns 🟢 green when
   it's connected.

Full detail, including how to make sign-ins long-lived, is in
**[docs/ADD_ACCOUNT.md](ADD_ACCOUNT.md)** and **[HELP.md](../HELP.md)**.

---

## Step 3 — Write the ChatGPT Codex config

This is the one Codex-specific action.

1. On the dashboard, find the **ChatGPT Codex** card (it's just below the Claude
   Desktop config row).
2. Click **Write ChatGPT Codex config**.

That single click **surgically merges** an `[mcp_servers.MultiMCP]` table — and its
`[mcp_servers.MultiMCP.env]` sub-table — into your Codex configuration file at
`~/.codex/config.toml` (on Windows, `%USERPROFILE%\.codex\config.toml`), or
`$CODEX_HOME/config.toml` if you've set that variable.

"Surgically" is meant literally. The app:

- **preserves everything else in the file** — your model choice, approval policy,
  plugins, project trust levels, any other MCP servers, and even your comments and
  formatting;
- **takes a timestamped backup first** (a `config.toml.bak-<timestamp>` right next to
  the file);
- **validates the result in memory before touching the disk**, writes atomically, then
  **re-reads and re-validates** what actually landed, restoring the backup if anything
  is off; and
- **refuses rather than guesses** — if it meets a file shape it can't edit safely, it
  changes nothing and tells you, so a bad edit can never break your Codex setup.

It points Codex at the **same** credentials folder as the tray app (and as Claude, if
you use it), which is why no account has to be signed in again.

> **If the card says Codex isn't installed:** the app didn't detect Codex on this PC,
> so it shows a short explanation instead of a button. Install Codex (or open it once
> so it creates `~/.codex`), then reopen the tray app and the button will appear.

---

## Step 4 — Restart Codex (fully — this is the step people miss)

Codex only reads its config **at startup**, so a newly-written server won't appear until
you restart. For the CLI and IDE extension, just start a new session.

For the **ChatGPT desktop app**, "restart" means a **full quit, not just closing the
window** — the app keeps running in the background, and a still-running app never
re-reads the config. Quit it completely (right-click the taskbar/tray icon → **Quit**,
or **File → Quit** / `Ctrl+Q`), make sure no ChatGPT/Codex process is left running, then
reopen it. After a proper restart, MultiMCP shows up in the next step. (If it still
doesn't appear, the app didn't fully quit — end any lingering `ChatGPT`/`codex` processes
in Task Manager and reopen.)

---

## Step 5 — Verify it landed (do this once — it matters)

### The quick check: `/mcp` in a chat

The fastest confirmation needs no terminal. Start a Codex session (in the desktop app,
the CLI, or the IDE extension) and type **`/mcp`** in the composer. Codex lists the MCP
servers it has connected — **`MultiMCP`** should be among them, marked **Enabled**. (The
same command works in the Codex CLI's terminal UI.) It shows next to Codex's own built-in
entries like `codex_apps` and `node_repl`; it says *"Auth unsupported"*, which is normal —
MultiMCP handles its own Google sign-in through the tray app, so Codex has nothing to
authenticate. If it's there, you're done.

If `MultiMCP` is **missing** from `/mcp`, it is almost always because the app wasn't
**fully quit** since you wrote the config (see Step 4) — the desktop app only builds this
list at a real startup, and closing the window doesn't count. Quit it completely, make
sure no `ChatGPT`/`codex` process is still running, reopen, and check again. A restart is
genuinely all it takes.

### The thorough check: `codex mcp get`

`/mcp` tells you the server connected; it doesn't tell you the *timeouts* took — and
those matter here, because a cold start is slow (see Step 6). This is worth knowing
because Codex **silently drops config keys it doesn't recognise**: a misspelled or
misplaced key is a no-op, not an error, so nothing in the UI or the logs will complain.
One command is the only way to *prove* the settings took effect.

There's a wrinkle: **the Codex CLI is not on your `PATH`.** It ships inside the desktop
app at a version-hashed path that changes every time Codex updates:

```
%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe
```

Run it from there, or from a terminal opened by the Codex IDE extension (which puts
`codex` on the path for that terminal). Then:

```
codex mcp get MultiMCP
```

You should see, among other things:

```
startup_timeout_sec: 120
tool_timeout_sec: 300
```

If those two values are present, the config landed correctly. If the command reports
that `MultiMCP` isn't found, or the timeouts are missing, the write didn't take — go
back to Step 3, then fully restart Codex.

You can also confirm MultiMCP is registered alongside anything else you had:

```
codex mcp list
```

`MultiMCP` should appear in the list next to your other MCP servers (the merge never
removes them).

---

## How to actually use it in a Codex session

Once Codex is restarted, the Google tools are available to the model. Internally they
appear with a prefix — `mcp__MultiMCP__<tool>` — for example:

- `mcp__MultiMCP__list_gmail_labels`
- `mcp__MultiMCP__search_gmail_messages`
- `mcp__MultiMCP__search_drive_files`
- `mcp__MultiMCP__list_calendars`
- `mcp__MultiMCP__get_events`

You don't type those names. You just ask in plain language, and Codex picks the right
tool. **The one thing you must supply is which account you mean** — the tools take a
`user_google_email`, so name the account in your request. If you only ever mention one
address, Codex will use that one consistently.

Here are prompts you could type in a Codex session (replace the emails with your own):

1. *"Using MultiMCP, search Gmail in `work@company.com` for unread messages from this
   week and give me a one-line summary of each."*
2. *"List the Gmail labels in `personal@gmail.com`."*
3. *"Search Drive in `work@company.com` for a file called 'Q3 budget' and show me the
   most recent match's contents."*
4. *"What's on my calendar tomorrow in `work@company.com`? Use the MultiMCP tools."*
5. *"Compare next week's calendar events between `work@company.com` and
   `personal@gmail.com` and tell me where they overlap."*
6. *"In `work@company.com`, find Gmail messages with invoices from last month and list
   the sender and amount for each."*

From there Codex can fold the results into whatever you're doing — summarising a
thread, dropping a list of events into a file it's editing, cross-referencing a Drive
document against your code, and so on.

> **The very first tool call can take up to about two minutes.** That's `uvx` warming
> up and provisioning the server on demand — it is **expected, not a hang**. It is
> precisely why the app sets `startup_timeout_sec = 120`; Codex's own 10-second default
> would kill the server mid-start. Every call after the first is fast.

---

## Running alongside Claude Desktop

Using Claude **and** Codex at the same time is fine and fully supported. Each client
launches its **own** copy of the server on its **own** port — Claude on **9000**, Codex
on **9001** (and your interactive sign-ins in the tray app on **8000**) — so they never
collide.

There is one honest caveat. Both clients share **one credentials folder**, and the
underlying `workspace-mcp` writes its token files without locking them. If Claude and
Codex happen to refresh the **same** account at the **very same instant**, that
account's token file can be left damaged — which looks exactly like a sign-in that has
died. The window is narrow, but running both clients is what makes it reachable.

Since **v0.5.1** the tray app **repairs this for you**: it keeps a spare copy of every
healthy token file, watches the credentials folder, and puts the spare back
automatically — usually within seconds — if it finds one damaged. Nothing of value is
lost in the swap. To be straight about it, this is a **repair, not a cure** (the faulty
write is upstream in `workspace-mcp`, not this app's code) — but it means the collision
should no longer cost you a re-auth. **The catch: this self-healing only happens while
the tray app is running**, so if you use both clients, keep the tray app open in the
background.

---

## Troubleshooting

**"Server failed to start" (or a startup timeout) on the first call.** This is almost
always the cold-start problem: the first time a new `workspace-mcp` version runs, `uvx`
has to install it (~90 packages), and until that finishes the server has nothing to
answer with. The app already sets `startup_timeout_sec = 120` for exactly this — so
first confirm the setting actually landed with `codex mcp get MultiMCP` (Codex silently
ignores keys it doesn't understand, so this is the only reliable proof). If it's there,
just let the install finish: **keep the tray app running** so it can pre-warm the engine
in the background (it does this on launch and every 6 hours), then **try again**. The
failed attempt itself usually completes the install, so the next one works. Remember a
healthy first call can still take up to ~2 minutes.

**The tools don't appear in Codex.** Fully **restart Codex** (it only reads its config
at startup), then confirm the entry is really there with `codex mcp get MultiMCP` and
`codex mcp list`. If `codex mcp get` doesn't show the entry, re-run **Write ChatGPT
Codex config** in the tray app and restart Codex again.

**A config that won't load / the app said it refused to write.** The app will **not**
write a `config.toml` shape it can't edit safely (for example, a root-level inline
`mcp_servers = { … }` table) — it refuses and changes nothing rather than risk
corrupting your Codex setup. If a write ever fails validation after the fact, it
**restores the backup** it took first. Look for a `config.toml.bak-<timestamp>` next to
your `config.toml`; that's the previous good copy. (A leading UTF-8 BOM is preserved but
can trip some TOML parsers — if Codex reports a broken config, re-saving the file as
UTF-8 *without* BOM is the first thing to try.)

**One account suddenly says "re-auth needed" while you're using both clients.** See
[Running alongside Claude Desktop](#running-alongside-claude-desktop) above — the app
now repairs this automatically, but if an account still shows re-auth needed after a
minute or two, open the tray app and click **Re-auth** on that one account.

More detail on all of the above, plus the full account-and-token picture, is in
**[HELP.md](../HELP.md)** (see the *Using it from OpenAI Codex* and *Troubleshooting*
sections).

---

## Removing it

To take the connector out of Codex, either:

- run **`codex mcp remove MultiMCP`**, or
- open `~/.codex/config.toml` in a text editor and delete the block the app added — the
  `[mcp_servers.MultiMCP]` table and its `[mcp_servers.MultiMCP.env]` sub-table, along
  with the `# >>> MultiMCP …` marker comment above them. Leave the rest of the file
  alone.

Then **restart Codex**.

> **One catch worth knowing.** Once you've clicked **Write ChatGPT Codex config**, the
> tray app treats that entry as its own and **puts it back if it goes missing** — the
> same self-repair that restores Claude's entry after a reinstall. So a hand-deletion
> reappears the next time the tray app launches. To remove it **permanently**, delete
> it *after* you've uninstalled the tray app — or simply leave it in place, since an MCP
> server Codex never calls costs you nothing. Removing the Codex entry does **not**
> affect your accounts, your saved sign-ins, or your Claude setup.

---

## Learn more

- **[HELP.md](../HELP.md)** — the full end-user guide (tray behaviour, security, the
  7-day re-auth, export/import, and the complete Codex section).
- **[docs/ADD_ACCOUNT.md](ADD_ACCOUNT.md)** — illustrated walkthrough for creating the
  shared OAuth client and adding each Google account.
- **[README.md](../README.md)** — project overview and the Claude Desktop guide.
- **[CHANGELOG.md](../CHANGELOG.md)** — what changed in each version.
