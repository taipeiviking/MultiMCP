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
  clipboard,
} = require("electron");
const path = require("path");
const fs = require("fs");

const credentials = require("./services/credentials");
const accounts = require("./services/accounts");
const serverManager = require("./services/serverManager");
const claudeConfig = require("./services/claudeConfig");
const log = require("./services/logger");

const isDev = !app.isPackaged;
const APP_ID = "com.local.googleworkspacemanager";
const HELP_URL = "https://github.com/taipeiviking/MultiMCP/blob/main/HELP.md";
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
    createTray();
    const startHidden =
      process.argv.includes("--hidden") ||
      app.getLoginItemSettings().wasOpenedAtLogin;
    createWindow({ show: !startHidden });
    scheduleExpiryChecks();

    app.on("activate", () => showWindow());
  });

  // With close-to-tray the window is hidden, not destroyed, so this rarely
  // fires; keep the app alive in the tray regardless (do NOT auto-quit).
  app.on("window-all-closed", () => {});

  app.on("before-quit", () => {
    isQuitting = true;
    if (expiryTimer) clearInterval(expiryTimer);
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
    title: "MultiMCP — Google Workspace Manager",
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

function getAutostartEnabled() {
  if (isDev) return autostartPref();
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return autostartPref();
  }
}

function setAutostartEnabled(enabled) {
  enabled = !!enabled;
  try {
    credentials.patchSettings({ autostart: enabled });
    if (!isDev) {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        args: ["--hidden"], // launch straight to the tray, no window
      });
    }
    log.info("autostart", "set", { enabled, isDev });
  } catch (e) {
    log.error("autostart", "failed", { message: String(e) });
  }
  rebuildTrayMenu();
  return getAutostartEnabled();
}

// Reconcile the OS login item with the saved preference at startup (packaged).
function applyAutostartPreference() {
  if (isDev) return;
  const desired = autostartPref();
  try {
    if (app.getLoginItemSettings().openAtLogin !== desired) {
      app.setLoginItemSettings({ openAtLogin: desired, args: ["--hidden"] });
      log.info("autostart", "reconciled at launch", { desired });
    }
  } catch (e) {
    log.error("autostart", "reconcile failed", { message: String(e) });
  }
}

// --- Expiry checks ----------------------------------------------------------

function scheduleExpiryChecks() {
  setTimeout(() => checkExpiries(false), 8000); // shortly after launch
  expiryTimer = setInterval(() => checkExpiries(false), EXPIRY_CHECK_INTERVAL_MS);
}

function checkExpiries(manual) {
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
    rebuildTrayMenu(); // status may have changed
    return r;
  });

  // claude config
  handle("claude:status", () => claudeConfig.getStatus());
  handle("claude:write", () => claudeConfig.writeServerEntry());

  // diagnostics
  handle("server:test", () => serverManager.testServer());
  handle("debug:get", () => ({
    logPath: log.getLogPath(),
    versions: process.versions,
    platform: process.platform,
  }));
  handle("debug:revealLog", async () => {
    const p = log.getLogPath();
    if (!p) return { ok: false, error: "No log path." };
    const dir = path.dirname(p);
    // Open the containing FOLDER via openPath. We deliberately avoid
    // shell.showItemInFolder: on Windows it routinely raises a native
    // "Location is not available" dialog (even when the path exists) when
    // Explorer is already open or for %APPDATA%\Roaming paths. openPath is
    // reliable and returns an error string instead of popping an OS dialog.
    try {
      fs.mkdirSync(dir, { recursive: true });
      const err = await shell.openPath(dir);
      if (err) {
        log.warn("revealLog", "openPath failed", { dir, err });
        return { ok: false, error: err, path: dir };
      }
      return { ok: true, path: dir };
    } catch (e) {
      log.error("revealLog", "failed", { message: String(e), dir });
      return { ok: false, error: String(e), path: dir };
    }
  });

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

  // Copy the log file path to the clipboard.
  handle("debug:copyLogPath", () => {
    const p = log.getLogPath();
    if (!p) return { ok: false, error: "No log path." };
    clipboard.writeText(p);
    return { ok: true, path: p };
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
}
