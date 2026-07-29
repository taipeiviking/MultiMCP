# Signal integration plan — MultiMCP v0.9

Goal: add **Signal messenger** as a second connector managed by this app, alongside
Google Workspace — same pattern the app already uses: the tray app handles the
one-time link/sign-in and status, Claude Desktop / Codex launch their own MCP
server process pointed at shared state.

Ordering decided earlier: **Signal first** (legal, stable backend, QR-link UX that
matches the app), **Telegram second** (official API), **WhatsApp only via the
unofficial bridge, behind an explicit ban-risk warning** — see the last section.

---

## 1. Backend: signal-cli (JSON-RPC daemon)

[`AsamK/signal-cli`](https://github.com/AsamK/signal-cli) is the de-facto standard
scripting interface to Signal:

- **Windows works.** Release archives bundle the JNI native libs for Windows x64;
  the runtime requirement is **Java 21** (see Runtime below).
- **Daemon mode with JSON-RPC over TCP** (`signal-cli daemon --tcp 127.0.0.1:<port>`)
  is the supported interface on Windows (the D-Bus interface is Linux-only). One
  long-lived process, newline-delimited JSON-RPC — same wire style the app already
  speaks to workspace-mcp in `serverManager.js`.
- **Linked-device model**: `signal-cli link -n "MultiMCP"` prints a `sgnl://linkdevice?...`
  URI; the user scans it as a QR code from their phone (Settings → Linked devices).
  The phone stays primary. This is the exact analog of our Google sign-in step.

### Data dir

`%LOCALAPPDATA%\MultiMCP\signal` passed via `--config`. Mirrors
`GOOGLE_MCP_CREDENTIALS_DIR`: shared state written by the tray app's link step,
read by the server Claude launches.

### The single-writer constraint (main design risk)

signal-cli **locks its data dir** — two processes can't use the same account
concurrently. Claude Desktop and Codex each spawn their own MCP server per
session, so naive "each MCP server spawns its own signal-cli" collides.

**Design: connect-first, spawn-if-absent.** The MCP server tries to connect to the
JSON-RPC daemon on a fixed localhost port (proposal: **7583**, "SVT" — pick any
unregistered port and pin it like `CLAUDE_MCP_PORT = 9000` is pinned today). If
nothing is listening, it spawns the daemon itself and owns it. Second and later
MCP servers find the port occupied and just connect. The daemon persists across
sessions, which also solves the "receive regularly or history desyncs" caveat.

---

## 2. Runtime: bundle a trimmed JRE (like we bundle uv)

signal-cli needs Java 21. Users must not install anything — same bar as uv.

- New `scripts/fetch-signal.js` (modeled on `scripts/fetch-uv.js`):
  1. Download the signal-cli Windows release archive → `vendor/signal/signal-cli/`.
  2. Download an Adoptium **Temurin 21 JRE** (windows x64) and `jlink`-trim it, or
     ship the stock JRE if trimming is more trouble than the ~40 MB saves →
     `vendor/signal/jre/`.
- `package.json` `build.extraResources`: add `vendor/signal` → `signal` next to the
  existing `vendor/uv` → `uv` entry.
- `serverManager.js` gets a sibling resolver: `bundledSignalCliPath()` /
  `bundledJavaPath()` following `bundledUvxPath()` exactly (packaged
  `process.resourcesPath` first, repo `vendor/` fallback in dev).

Installer size grows by roughly 60–90 MB (signal-cli + JRE). Acceptable; note it
in the release notes.

---

## 3. The MCP server: `multimcp-signal` (ours, in-repo)

Surveyed the community servers; none clears the bar:

| Project | Runtime | State |
|---|---|---|
| [retog/signal-mcp](https://github.com/retog/signal-mcp) | Deno | Decent tool list, wrong runtime (we bundle uv, not Deno) |
| [rymurr/signal-mcp](https://github.com/rymurr/signal-mcp) | Python | 3 tools, 4 commits, not on PyPI |
| [hypernormal/signal-cli-mcp](https://github.com/hypernormal/signal-cli-mcp) | Go | Would mean shipping a third runtime artifact |

**Build our own thin Python package** in-repo at `python/multimcp-signal/`
(FastMCP + the official `mcp` SDK), launched with the **bundled uvx** —
`uvx --from <path-or-wheel> multimcp-signal` — so the launch mechanics match
workspace-mcp identically. It is a thin JSON-RPC client over the daemon
(~400 lines), not a Signal implementation. Publish to PyPI later if useful;
`--from` a local wheel shipped in resources works from day one.

### Tools (v1)

Read-heavy first, mirroring how the Google tools are used:

- `list_conversations` — contacts + groups with last-activity
- `get_messages` — recent messages for a conversation (paged)
- `search_messages` — text search over the local message store
- `send_message` — to a contact or group (the one write tool)
- `get_attachment` — download/read an attachment by id
- `mark_read` — optional, v1.1

Env contract (set in the written config entry, mirroring the Google env block):
`SIGNAL_ACCOUNT` (E.164 number), `SIGNAL_CLI_PATH`, `SIGNAL_JAVA_HOME`,
`SIGNAL_CONFIG_DIR`, `SIGNAL_DAEMON_PORT`.

---

## 4. Config writing: generalize, don't duplicate

`claudeConfig.js` / `codexConfig.js` are single-entry (`SERVER_KEY = "MultiMCP"`)
but their hard-won machinery — backup, atomic tmp+rename write, on-disk verify
with rollback, legacy-key cleanup, `healServerEntryIfStale()` — is exactly what
the Signal entry needs too.

- Extract the write/verify/heal core into `electron/services/mcpConfigWriter.js`
  operating on a **list of (key, entry) pairs**; `claudeConfig.js` and
  `codexConfig.js` become entry-builders that pass
  `[["MultiMCP", googleEntry], ["MultiMCP-Signal", signalEntry?]]`.
- New key: **`MultiMCP-Signal`**. Include it only when a Signal account is linked;
  `verifyOnDisk` and `CRITICAL_ENV`-style staleness checks extend per-entry.
- One **Write config** button still writes everything — the user story stays
  "click once, restart Claude".

Existing `tokenGuard.js` gets a Signal sibling: "stale link" detection = daemon
reports the account unregistered / receive fails with auth error → card turns
amber, same UX as the Google 7-day-token warning.

---

## 5. UI: from account list to service sections

`Dashboard.jsx` currently renders one implicit service. Introduce sections:

- **Google Workspace** — existing `AccountCard` list, unchanged.
- **Signal** — one card (single linked account for v1):
  - *Not linked*: "Link with your phone" → IPC `signal.link` runs
    `signal-cli link -n "MultiMCP"`, captures the `sgnl://` URI from stdout,
    renders it as a QR in a modal (add the `qrcode` npm package — renders offline,
    no network). Poll until the link completes or times out (reuse the 10-min
    `SIGNIN_TIMEOUT_MS` pattern and its rationale).
  - *Linked*: show the phone number, 🟢/🟠 status via a lightweight daemon probe,
    an **Unlink** button, and "last received" freshness.
- Preload/`main.js`: new IPC namespace `signal.{status,link,unlink,probe}`
  following the existing `accounts.*` shape.

---

## 6. Milestones

1. **Refactor** — extract `mcpConfigWriter.js`; Claude + Codex writers pass the
   existing tests (extend `tomlEdit.test.js`-style coverage to the writer core).
   No behavior change shipped alone.
2. **Vendoring** — `fetch-signal.js`, extraResources, path resolvers. `signal-cli
   --version` runs from the packaged layout.
3. **Link flow** — IPC + QR modal + Signal card; account links and persists in the
   shared data dir.
4. **`multimcp-signal`** — the Python server + daemon spawn/connect logic; tools
   usable from Claude Desktop end-to-end.
5. **Hardening + release (v0.9.0)** — heal/staleness for the Signal entry, README +
   HELP sections, CHANGELOG, installer-size note. App name likely stays
   "Google Workspace Manager" in the installer until a broader rename is decided
   (the repo is already "MultiMCP"; renaming the product is its own small project —
   appId change breaks over-the-top installs, so treat it separately).

Rough effort: milestones 1–2 are a day each; 3–4 are the bulk (2–4 days each);
5 is a day. All local, no new cloud accounts or fees.

---

## 7. After Signal (for reference, not in this scope)

- **Telegram (next)** — official MTProto user API via Telethon. Login = phone
  number + code typed into the app (no QR needed). Needs a per-user `api_id` /
  `api_hash` from my.telegram.org — same one-time-credential UX as the Google
  OAuth Client ID/Secret setup screen, so `CredentialsSetup.jsx` generalizes.
  Server: same in-repo Python package approach (`multimcp-telegram`).
- **WhatsApp (opt-in, warned)** — no official personal-account API. The viable
  route is a web-client bridge (whatsapp-web.js / Baileys style), which violates
  WhatsApp ToS and **risks a permanent number ban**. If added: off by default,
  explicit risk-acknowledgement dialog before linking, read-heavy tool set, no
  bulk send. Decision deferred until Signal + Telegram ship.
