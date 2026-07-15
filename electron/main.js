// Electron main process.
// Owns the only privileged surface: filesystem, child processes, Credential Manager.
// The renderer talks to these ONLY through the typed IPC channels registered below.
//
// Runs as a background TRAY app:
//  - Closing the window hides it to the tray (the app keeps running).
//  - Optional "start with Windows" (registers only in a packaged build).
//  - Periodic token-expiry check with a native notification + one-click re-auth.
// NOTE: this control panel does NOT need to run for Claude Desktop to use the
// accounts — Claude spawns its own uvx workspace-mcp per session from the shared
// credentials dir. The tray app exists to warn before the ~7-day token expiry.

const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  Tray,
  Menu,
  nativeImage,
  Notification,
  dialog,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

const credentials = require("./services/credentials");
const accounts = require("./services/accounts");
const serverManager = require("./services/serverManager");
const claudeConfig = require("./services/claudeConfig");
const codexConfig = require("./services/codexConfig");
const noBrowser = require("./services/noBrowser");
const tokenGuard = require("./services/tokenGuard");
const guidance = require("./services/guidance");
const backup = require("./services/backup");
const log = require("./services/logger");

const isDev = !app.isPackaged;
const APP_ID = "com.local.googleworkspacemanager";
const HELP_URL = "https://github.com/taipeiviking/MultiMCP/blob/main/HELP.md";
// Per-client usage guides, opened from the two config cards. Keyed, not free-form:
// the renderer sends a KEY, never a URL, so nothing it receives can redirect this
// to an arbitrary destination.
const DOC_URLS = {
  claude: "https://github.com/taipeiviking/MultiMCP/blob/main/docs/README_Claude.md",
  chatgpt: "https://github.com/taipeiviking/MultiMCP/blob/main/docs/README_ChatGPT.md",
};
const EXPIRY_WARN_MS = 48 * 3600 * 1000; // warn when re-auth is due within 48h
const EXPIRY_CHECK_INTERVAL_MS = 6 * 3600 * 1000; // re-check every 6h

let win = null;
let tray = null;
let isQuitting = false;
let expiryTimer = null;
const notifiedState = new Map(); // email -> last notified state ("expired"|"soon")

// Single-instance: a tray/autostart app must never run twice.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  bootstrap();
}

function bootstrap() {
  app.setAppUserModelId(APP_ID);

  app.whenReady().then(() => {
    log.init();
    log.info("app", "app ready", {
      isDev,
      version: app.getVersion(),
      argv: process.argv.slice(1),
    });
    registerIpc();
    Menu.setApplicationMenu(null); // no native menu bar; Help is an in-app button
    applyAutostartPreference();
    // Create the no-op browser shim BEFORE healing the config: buildEntry() only
    // sets BROWSER when the shim exists on disk, so if this ran after the heal, the
    // first launch after an update would write an entry without it.
    noBrowser.ensureShim();
    // Self-heal a stale Claude config (bare "uvx" / missing path -> bundled path,
    // and any drift in a load-bearing env key), so an old config can't keep causing
    // Claude's "spawn uvx ENOENT" - or, since v0.4.0, the spurious OAuth tabs.
    claudeConfig
      .healServerEntryIfStale()
      .then((r) => r.healed && log.info("app", "claude config auto-healed", r))
      .catch((e) => log.error("app", "config heal error", { message: String(e) }));
    // Same for Codex, but ONLY on machines where we already wrote its config once
    // (the codexConfigWritten marker). We never volunteer ourselves into a Codex
    // setup the user never asked us to touch.
    codexConfig
      .healServerEntryIfStale()
      .then((r) => r.healed && log.info("app", "codex config auto-healed", r))
      .catch((e) => log.error("app", "codex heal error", { message: String(e) }));
    watchClientConfigs();
    createTray();
    const startHidden =
      process.argv.includes("--hidden") ||
      app.getLoginItemSettings().wasOpenedAtLogin;
    createWindow({ show: !startHidden });
    // Warm the uvx/workspace-mcp cache so Claude Desktop's own server attaches fast
    // (a cold install of a new workspace-mcp version can exceed Claude's MCP timeout).
    serverManager.prewarm();
    scheduleExpiryChecks();

    app.on("activate", () => showWindow());
  });

  // With close-to-tray the window is hidden, not destroyed, so this rarely
  // fires; keep the app alive in the tray regardless (do NOT auto-quit).
  app.on("window-all-closed", () => {});

  app.on("before-quit", () => {
    isQuitting = true;
    if (expiryTimer) clearInterval(expiryTimer);
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* already gone */
      }
    }
    serverManager.stopAll().catch(() => {});
  });

  process.on("uncaughtException", (err) =>
    log.error("process", "uncaughtException", {
      message: String(err),
      stack: err && err.stack,
    })
  );
  process.on("unhandledRejection", (reason) =>
    log.error("process", "unhandledRejection", { reason: String(reason) })
  );
}

// --- Window -----------------------------------------------------------------

const DEFAULT_BOUNDS = { width: 1100, height: 760 };
const MIN_WIDTH = 880;
const MIN_HEIGHT = 600;

// Restore the last-used window size/position (persisted in settings.json), so the
// user sizes the window once and it sticks. Sizes are in DIPs (DPI-independent),
// which is why we persist them rather than hard-code pixels.
function savedBounds() {
  const b = credentials.readSettings().windowBounds;
  if (!b || typeof b.width !== "number" || typeof b.height !== "number") return null;
  return b;
}

function persistBounds() {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
  try {
    const b = win.getBounds();
    credentials.patchSettings({ windowBounds: b });
  } catch {}
}

function createWindow({ show } = { show: true }) {
  const b = savedBounds() || DEFAULT_BOUNDS;
  win = new BrowserWindow({
    width: b.width,
    height: b.height,
    x: typeof b.x === "number" ? b.x : undefined,
    y: typeof b.y === "number" ? b.y : undefined,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false, // shown on ready-to-show (avoids white flash) unless startHidden
    backgroundColor: "#0e1116",
    title: `MultiMCP — Google Workspace Manager  v${app.getVersion()}`,
    icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev) {
    win.loadURL("http://localhost:5173");
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  win.once("ready-to-show", () => {
    if (show) win.show();
  });

  // Remember size/position whenever the user resizes or moves the window.
  win.on("resize", persistBounds);
  win.on("move", persistBounds);

  // Close = hide to tray (unless the user chose Quit).
  win.on("close", (e) => {
    persistBounds();
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
      notifyFirstHide();
    }
  });
  win.on("closed", () => {
    win = null;
  });

  // Force OAuth / external links into the system browser, never an Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow({ show: true });
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

let hideHintShown = false;
function notifyFirstHide() {
  if (hideHintShown) return;
  hideHintShown = true;
  if (Notification.isSupported()) {
    new Notification({
      title: "Still running in the tray",
      body: "Workspace Manager keeps running so it can warn you before accounts expire. Quit from the tray icon.",
      icon: path.join(__dirname, "assets", "icon.png"),
    }).show();
  }
}

// --- Tray -------------------------------------------------------------------

function trayImage() {
  const p = path.join(__dirname, "assets", "tray.png");
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? undefined : img;
}

function createTray() {
  const img = trayImage();
  tray = new Tray(img || nativeImage.createEmpty());
  tray.setToolTip("Google Workspace Manager");
  tray.on("click", () => showWindow());
  tray.on("double-click", () => showWindow());
  rebuildTrayMenu();
}

function accountSummaryLines() {
  let list = [];
  try {
    list = accounts.listAccounts();
  } catch (e) {
    return { items: [{ label: "Status unavailable", enabled: false }], tip: "" };
  }
  if (list.length === 0) {
    return {
      items: [{ label: "No accounts added yet", enabled: false }],
      tip: "Google Workspace Manager — no accounts",
    };
  }
  const items = list.map((a) => {
    const state = !a.connected
      ? "not connected"
      : !a.hasRefresh
      ? "needs re-auth"
      : a.expired
      ? "re-auth needed"
      : expiryShort(a.expiry);
    return {
      label: `${dot(a)}  ${a.email} — ${state}`,
      click: () => showWindow(),
    };
  });
  const bad = list.filter((a) => !a.connected || a.expired || !a.hasRefresh).length;
  const tip =
    bad > 0
      ? `Workspace Manager — ${bad} account(s) need attention`
      : `Workspace Manager — ${list.length} account(s) OK`;
  return { items, tip };
}

function dot(a) {
  if (!a.connected || a.expired || !a.hasRefresh) return "●"; // attention
  return "○";
}

function expiryShort(iso) {
  if (!iso) return "connected";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "re-auth needed";
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  return d > 0 ? `re-auth in ${d}d ${h}h` : `re-auth in ${h}h`;
}

function rebuildTrayMenu() {
  if (!tray) return;
  const { items, tip } = accountSummaryLines();
  tray.setToolTip(tip);

  const autostart = getAutostartEnabled();
  const menu = Menu.buildFromTemplate([
    { label: "Open Dashboard", click: () => showWindow() },
    { type: "separator" },
    { label: "Accounts", enabled: false },
    ...items,
    { type: "separator" },
    { label: "Re-check now", click: () => checkExpiries(true) },
    {
      label: "Start with Windows",
      type: "checkbox",
      checked: autostart,
      click: (item) => setAutostartEnabled(item.checked),
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

// --- Autostart (OS login item) ---------------------------------------------

// Autostart preference is persisted in settings.json and defaults to ON. The
// real OS login item is only registered in a packaged build (a dev login item
// would point at the raw Electron binary). On launch we reconcile the OS login
// item to the saved preference (applyAutostartPreference), so "default on"
// actually takes effect the first time the installed app runs.
function autostartPref() {
  return credentials.readSettings().autostart !== false; // default true
}

// The checkbox always reflects the *persisted preference*, not the live OS login
// item. Querying the OS item is unreliable (returns false when running the loose
// win-unpacked exe, and the path/args must match exactly), which made the toggle
// look unchecked and "not clickable". The OS login item is a best-effort
// side-effect we set in setAutostartEnabled and reconcile at launch.
function getAutostartEnabled() {
  return autostartPref();
}

// Autostart uses TWO mechanisms for reliability:
//   1. A Task Scheduler "At log on" task (primary). Scheduled tasks fire reliably
//      after login — including after a Windows "Fast Startup" (hybrid) resume,
//      which can silently skip HKCU\...\Run entries.
//   2. The HKCU\...\Run value (fallback). Kept so autostart still works if the
//      scheduled task can't be created (locked-down machines, group policy).
// Both launch the SAME command; the app's single-instance lock means that even if
// both fire, only one instance runs.
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
// Task Scheduler task name (kept stable so we overwrite, not duplicate).
const TASK_NAME = "GoogleWorkspaceManagerAutostart";

// The installed exe path contains spaces, so it MUST be quoted everywhere it's
// used as a command; an unquoted "...\Google Workspace Manager.exe" makes Windows
// try to run "...\Google" and the app silently never starts.
function autostartCommand() {
  return `"${process.execPath}" --hidden`;
}

// --- Task Scheduler primary mechanism ---------------------------------------
//
// We create the logon task via PowerShell's ScheduledTasks module, NOT
// `schtasks /SC ONLOGON`. Why: `schtasks /SC ONLOGON` registers a machine-wide
// logon trigger and requires ELEVATION ("Access is denied" for a normal user).
// Register-ScheduledTask with an -AtLogOn trigger scoped to the CURRENT USER
// registers under the user and succeeds WITHOUT admin — which is what we need,
// since the app runs unelevated. The task runs with limited rights in the
// interactive session, so the tray icon shows normally.

// Run a PowerShell snippet, returning true on exit 0. Uses -NoProfile so a slow/
// broken user profile can't hang or fail it.
function runPowerShell(script) {
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true, stdio: "ignore" }
  );
}

function writeAutostartTask() {
  try {
    // Build the task in-script. Escape single quotes in the exe path for PS.
    const exe = process.execPath.replace(/'/g, "''");
    const ps =
      `$a = New-ScheduledTaskAction -Execute '${exe}' -Argument '--hidden'; ` +
      `$t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME; ` +
      // Allow it to run on battery / not stop after a time limit (default settings
      // would stop the tray app after 3 days on some policies).
      `$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries ` +
      `-DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) ` +
      `-StartWhenAvailable; ` +
      `Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $a -Trigger $t ` +
      `-Settings $s -Force | Out-Null`;
    runPowerShell(ps);
    return true;
  } catch (e) {
    log.warn("autostart", "logon task create failed (falling back to Run key)", {
      message: String(e),
    });
    return false;
  }
}

function removeAutostartTask() {
  try {
    runPowerShell(
      `Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false ` +
        `-ErrorAction SilentlyContinue`
    );
  } catch {
    /* task already absent */
  }
}

function autostartTaskExists() {
  try {
    runPowerShell(
      `if (-not (Get-ScheduledTask -TaskName '${TASK_NAME}' ` +
        `-ErrorAction SilentlyContinue)) { exit 1 }`
    );
    return true;
  } catch {
    return false;
  }
}

// --- HKCU Run fallback mechanism --------------------------------------------

function writeAutostartRegistry(enabled) {
  if (enabled) {
    execFileSync("reg.exe", [
      "add", RUN_KEY, "/v", APP_ID, "/t", "REG_SZ",
      "/d", autostartCommand(), "/f",
    ]);
  } else {
    try {
      execFileSync("reg.exe", ["delete", RUN_KEY, "/v", APP_ID, "/f"]);
    } catch {
      /* value already absent */
    }
  }
}

function readAutostartRegistry() {
  try {
    const out = execFileSync("reg.exe", ["query", RUN_KEY, "/v", APP_ID]).toString();
    const m = out.match(/REG_SZ\s+(.*)\s*$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null; // value not present
  }
}

// --- Combined enable/disable + reconcile ------------------------------------

function setAutostartEnabled(enabled) {
  enabled = !!enabled;
  try {
    credentials.patchSettings({ autostart: enabled });
    if (!isDev) {
      if (enabled) {
        writeAutostartTask();
        writeAutostartRegistry(true);
      } else {
        removeAutostartTask();
        writeAutostartRegistry(false);
      }
    }
    log.info("autostart", "set", { enabled, isDev, cmd: autostartCommand() });
  } catch (e) {
    log.error("autostart", "failed", { message: String(e) });
  }
  rebuildTrayMenu();
  return getAutostartEnabled();
}

// Reconcile both mechanisms with the saved preference at startup (packaged). This
// self-heals: creates the scheduled task if it's missing, and rewrites a stale/
// unquoted Run value. Idempotent.
function applyAutostartPreference() {
  if (isDev) return;
  const desired = autostartPref();
  try {
    // Task Scheduler (primary)
    const taskThere = autostartTaskExists();
    if (desired && !taskThere) {
      writeAutostartTask();
      log.info("autostart", "created logon task", { task: TASK_NAME });
    } else if (!desired && taskThere) {
      removeAutostartTask();
      log.info("autostart", "removed logon task", { task: TASK_NAME });
    }
    // Run key (fallback) — keep it correct too
    const current = readAutostartRegistry();
    const want = desired ? autostartCommand() : null;
    if (current !== want) {
      writeAutostartRegistry(desired);
      log.info("autostart", "reconciled run key", { desired, was: current, now: want });
    }
  } catch (e) {
    log.error("autostart", "reconcile failed", { message: String(e) });
  }
}

// --- Expiry checks ----------------------------------------------------------

// Keep the client configs correct even while we are just sitting in the tray.
//
// Healing only at OUR startup is not enough, because the clients write these files
// too. Claude Desktop in particular persists the connector list it loaded at ITS
// startup back to claude_desktop_config.json -- so a Claude that is still running an
// old config will happily put the old entry back, and the user's NEXT Claude launch
// then loads it. Observed live: a "google_workspace" key we had already renamed
// reappeared while Claude was open. The result would look exactly like the OAuth-tab
// bug coming back from the dead.
//
// So watch both files and re-heal on change. Healing is idempotent -- when the entry
// is already right it writes nothing -- so our own writes cannot start a loop.
const watchers = [];

// The credentials dir is written by the SERVERS (Claude's and Codex's), not by us, so
// a clobbered token can appear at any moment - not just at the times we happen to
// look. Sweeping only at launch and every six hours would leave an account looking
// broken for hours. Watch the directory and repair within seconds instead.
//
// Our own restore write re-triggers this, which is harmless: the second sweep finds a
// healthy file and writes nothing.
function watchCredentialsDir() {
  const dir = credentials.credentialsDir();
  if (!fs.existsSync(dir)) return;
  let timer = null;
  let w;
  try {
    w = fs.watch(dir, () => {
      clearTimeout(timer);
      // Debounce well past a single refresh write: we want to look AFTER the writer
      // has finished, or we would "repair" a file that is merely mid-write.
      timer = setTimeout(() => {
        try {
          const r = tokenGuard.sweep();
          if (r.repaired.length) {
            log.warn("app", "repaired token file(s) after an external write", r);
          }
        } catch (e) {
          log.error("app", "token guard sweep failed", { message: String(e) });
        }
      }, 2500);
    });
  } catch (e) {
    log.warn("app", "could not watch credentials dir", { dir, message: String(e) });
    return;
  }
  w.on("error", (e) => log.warn("app", "credentials watcher error", { message: String(e) }));
  watchers.push(w);
  log.info("app", "watching credentials dir for clobbered token files", { dir });
}

function watchClientConfigs() {
  watchCredentialsDir();
  const targets = [
    { name: "claude", file: claudeConfig.configPath(), heal: () => claudeConfig.healServerEntryIfStale() },
    { name: "codex", file: codexConfig.configPath(), heal: () => codexConfig.healServerEntryIfStale() },
  ];

  for (const t of targets) {
    const dir = path.dirname(t.file);
    const base = path.basename(t.file);
    if (!fs.existsSync(dir)) continue; // client not installed; nothing to watch

    let timer = null;
    let w;
    try {
      // Watch the DIRECTORY, not the file: an atomic writer (ours included) replaces
      // the file by rename, which breaks a watch bound to the old inode/handle.
      w = fs.watch(dir, (_event, filename) => {
        if (filename && filename !== base) return;
        clearTimeout(timer);
        // Debounce: a single logical save can fire several change events, and the
        // writer may be mid-write when the first one arrives.
        timer = setTimeout(async () => {
          try {
            const r = await t.heal();
            if (r && r.healed) {
              log.info("app", `${t.name} config changed externally - re-healed`, r);
            }
          } catch (e) {
            log.error("app", `${t.name} watch heal failed`, { message: String(e) });
          }
        }, 1500);
      });
    } catch (e) {
      log.warn("app", `could not watch ${t.name} config`, { dir, message: String(e) });
      continue;
    }
    w.on("error", (e) => log.warn("app", `${t.name} config watcher error`, { message: String(e) }));
    watchers.push(w);
    log.info("app", `watching ${t.name} config for external changes`, { file: t.file });
  }
}

function scheduleExpiryChecks() {
  setTimeout(() => checkExpiries(false), 8000); // shortly after launch
  expiryTimer = setInterval(() => checkExpiries(false), EXPIRY_CHECK_INTERVAL_MS);
}

async function checkExpiries(manual) {
  // Keep the uvx/workspace-mcp cache warm (runs ~8s after launch, then every 6h) so a
  // workspace-mcp version bump installs in the background here — not during Claude's
  // attach, which would time out ("Could not attach to MCP server"). Non-blocking.
  serverManager.prewarm();
  // Back up healthy token files, and repair any that a concurrent refresh clobbered,
  // BEFORE verifying them - otherwise a repairable file would be reported to the user
  // as an account that needs re-authorizing.
  try {
    tokenGuard.sweep();
  } catch (e) {
    log.error("expiry", "token guard sweep failed", { message: String(e) });
  }
  // Verify refresh tokens against Google so status reflects reality, not a clock.
  try {
    await accounts.verifyAll();
  } catch (e) {
    log.error("expiry", "verifyAll failed", { message: String(e) });
  }
  await reportSuppressedAuth();
  let list = [];
  try {
    list = accounts.listAccounts();
  } catch (e) {
    log.error("expiry", "listAccounts failed", { message: String(e) });
    return;
  }
  rebuildTrayMenu();

  for (const a of list) {
    const state = classify(a);
    const prev = notifiedState.get(a.email);
    if (state === "ok") {
      notifiedState.delete(a.email);
      continue;
    }
    if (state !== prev) {
      notifiedState.set(a.email, state);
      notifyExpiry(a, state);
    }
  }

  if (manual) {
    const bad = list.filter((a) => classify(a) !== "ok");
    if (Notification.isSupported()) {
      new Notification({
        title: "Workspace Manager",
        body:
          bad.length === 0
            ? "All accounts are connected and current."
            : `${bad.length} account(s) need re-auth.`,
        icon: path.join(__dirname, "assets", "icon.png"),
      }).show();
    }
  }
}

// Claude's background server can still decide an account needs authorizing (a truly
// revoked token, a deleted credential file). We stop it opening a browser tab
// (noBrowser.js), which means the demand would otherwise be INVISIBLE - the user
// would just see a tool call fail. So read what the shim swallowed and turn it into
// something honest: verify the account for real, and only then tell the user.
async function reportSuppressedAuth() {
  let suppressed = [];
  try {
    suppressed = noBrowser.readSuppressed();
  } catch (e) {
    log.error("noBrowser", "could not read suppressed auth log", { message: String(e) });
    return;
  }
  if (!suppressed.length) return;

  const emails = [...new Set(suppressed.map((s) => s.email).filter(Boolean))];
  log.info("noBrowser", "background server tried to open OAuth tabs (suppressed)", {
    count: suppressed.length,
    emails,
  });
  noBrowser.clearSuppressed();

  for (const email of emails) {
    let ok = false;
    try {
      const res = await accounts.verifyAccount(email);
      ok = !!(res && res.ok);
    } catch {
      ok = false;
    }
    if (ok) {
      // The token is fine, so the server should never have asked. That means the
      // MCP_SINGLE_USER_MODE fix has regressed (or Claude is running a stale entry
      // from before the fix). Don't nag the user about an account that works.
      log.warn("noBrowser", "auth demanded for an account whose token verifies OK", {
        email,
        hint: "stale Claude config, or upstream changed MCP_SINGLE_USER_MODE semantics",
      });
      continue;
    }
    if (Notification.isSupported()) {
      const n = new Notification({
        title: "Google Workspace Manager",
        body: `${email} needs to be signed in again. Open the app and click Re-auth.`,
        icon: path.join(__dirname, "assets", "icon.png"),
      });
      n.on("click", () => showWindow());
      n.show();
    }
  }
}

function classify(a) {
  if (!a.connected || !a.hasRefresh || a.expired) return "expired";
  if (a.expiry && new Date(a.expiry).getTime() - Date.now() < EXPIRY_WARN_MS)
    return "soon";
  return "ok";
}

function notifyExpiry(a, state) {
  if (!Notification.isSupported()) return;
  const body =
    state === "expired"
      ? `${a.email} needs re-authentication. Click to open and re-auth.`
      : `${a.email} ${expiryShort(a.expiry)}. Click to re-auth before it expires.`;
  const n = new Notification({
    title: "Google account needs attention",
    body,
    icon: path.join(__dirname, "assets", "icon.png"),
  });
  n.on("click", () => showWindow());
  n.show();
  log.info("expiry", "notified", { email: a.email, state });
}

// --- IPC --------------------------------------------------------------------

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, payload) => {
    const t0 = Date.now();
    log.info("ipc", `→ ${channel}`, payload);
    try {
      const result = await fn(payload, _e);
      log.info("ipc", `← ${channel} ok`, { ms: Date.now() - t0, result });
      return result;
    } catch (err) {
      log.error("ipc", `✗ ${channel} threw`, {
        ms: Date.now() - t0,
        message: String(err && err.message ? err.message : err),
        stack: err && err.stack,
      });
      throw err;
    }
  });
}

function registerIpc() {
  // credentials
  handle("creds:get", () => credentials.getClientConfig());
  handle("creds:save", ({ clientId, clientSecret }) =>
    credentials.saveClientConfig(clientId, clientSecret)
  );

  // prerequisites
  handle("prereq:check", () => serverManager.checkPrerequisites());

  // accounts
  handle("accounts:list", () => accounts.listAccounts());
  handle("accounts:add", ({ email }) => accounts.addAccount(email));
  handle("accounts:remove", ({ email }) => accounts.removeAccount(email));
  handle("accounts:authorize", async ({ email }) => {
    const r = await serverManager.authorizeAccount(email);
    // Confirm the just-issued token actually works (and refresh stored status).
    try {
      await accounts.verifyAccount(email);
    } catch (e) {
      log.warn("ipc", "post-authorize verify failed", { message: String(e) });
    }
    rebuildTrayMenu(); // status may have changed
    return r;
  });

  handle("accounts:verify", async () => {
    const list = await accounts.verifyAll();
    rebuildTrayMenu();
    return list;
  });

  // production-mode preference (drops the 7-day countdown; status is verify-driven)
  handle("prefs:get", () => {
    const s = credentials.readSettings();
    return {
      productionMode: s.productionMode === true,
      productionModeSource: s.productionModeSource || null,
    };
  });
  handle("prefs:set", ({ productionMode }) => {
    const patch = {};
    if (typeof productionMode === "boolean") {
      patch.productionMode = productionMode;
      patch.productionModeSource = productionMode ? "user" : null;
    }
    const s = credentials.patchSettings(patch);
    rebuildTrayMenu();
    return {
      productionMode: s.productionMode === true,
      productionModeSource: s.productionModeSource || null,
    };
  });

  // claude config
  handle("claude:status", () => claudeConfig.getStatus());
  handle("claude:write", () => claudeConfig.writeServerEntry());

  // Agent guidance: the rules that tell a client's AI to use MultiMCP (and specify
  // an account) instead of a built-in single-account integration.
  handle("guidance:status", ({ client }) => guidance.getStatus(client));
  handle("guidance:apply", ({ client, targetKey }) => guidance.apply(client, targetKey));

  handle("codex:status", () => codexConfig.getStatus());
  // Return the failure instead of throwing: writing this one edits a TOML file the
  // user owns, and the service deliberately REFUSES on any shape it cannot edit
  // safely. The renderer shows that reason verbatim - a silent no-op would be worse.
  handle("codex:write", async () => {
    try {
      return await codexConfig.writeServerEntry();
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  // diagnostics
  handle("server:test", () => serverManager.testServer());
  handle("app:version", () => app.getVersion());
  handle("debug:get", () => ({
    logPath: log.getLogPath(),
    version: app.getVersion(),
    versions: process.versions,
    platform: process.platform,
  }));
  // Read the log file for the in-app viewer. Returns the tail (last ~256 KB) so
  // huge logs don't blow up the renderer. We view in-app rather than launching
  // an external editor because the Windows 11 Store Notepad fails to open
  // %APPDATA% paths ("system cannot find the path specified") no matter how it's
  // invoked (shell.openPath OR spawning the notepad.exe app-execution alias).
  handle("debug:readLog", () => {
    const p = log.getLogPath();
    if (!p) return { ok: false, error: "No log path." };
    try {
      if (!fs.existsSync(p)) return { ok: true, text: "(log is empty)", path: p, bytes: 0 };
      const MAX = 256 * 1024;
      const stat = fs.statSync(p);
      const fd = fs.openSync(p, "r");
      try {
        const start = stat.size > MAX ? stat.size - MAX : 0;
        const len = stat.size - start;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, start);
        let text = buf.toString("utf8");
        if (start > 0) {
          text = "…(showing last 256 KB of " + Math.round(stat.size / 1024) + " KB)…\n" +
            text.slice(text.indexOf("\n") + 1);
        }
        return { ok: true, text, path: p, bytes: stat.size };
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      log.error("readLog", "failed", { message: String(e), p });
      return { ok: false, error: String(e), path: p };
    }
  });

  // tray / autostart
  handle("autostart:get", () => ({ enabled: getAutostartEnabled(), isDev }));
  handle("autostart:set", ({ enabled }) => ({
    enabled: setAutostartEnabled(!!enabled),
    isDev,
  }));

  // help
  handle("help:open", () => {
    shell.openExternal(HELP_URL);
    return { ok: true, url: HELP_URL };
  });

  // Open a per-client usage guide on GitHub. Only known keys resolve to a URL; an
  // unknown key is ignored rather than opening anything.
  handle("docs:open", ({ key } = {}) => {
    const url = DOC_URLS[key];
    if (!url) return { ok: false, error: `unknown doc key: ${key}` };
    shell.openExternal(url);
    return { ok: true, url };
  });

  // settings backup: export to a JSON file (carries Client ID+secret, accounts,
  // and the per-account refresh-token files — everything the other machine needs).
  handle("backup:export", async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: "Export settings",
      defaultPath: `google-workspace-manager-backup-${stamp}.json`,
      filters: [{ name: "GWM backup", extensions: ["json"] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      return await backup.exportToFile(filePath);
    } catch (e) {
      log.error("backup", "export failed", { message: String(e) });
      return { ok: false, error: String(e) };
    }
  });

  // settings backup: import from a JSON file. Two-step — pick + inspect, then the
  // renderer confirms and calls backup:import with the chosen path.
  handle("backup:pick", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: "Import settings",
      properties: ["openFile"],
      filters: [{ name: "GWM backup", extensions: ["json"] }],
    });
    if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true };
    const info = backup.inspectFile(filePaths[0]);
    return { ...info, path: filePaths[0] };
  });

  handle("backup:import", async ({ path: filePath, overwrite }) => {
    if (!filePath) return { ok: false, error: "No file selected." };
    const r = await backup.importFromFile(filePath, { overwrite: !!overwrite });
    if (r.ok) {
      // Token files / accounts changed underneath us — refresh tray status.
      rebuildTrayMenu();
    }
    return r;
  });
}
