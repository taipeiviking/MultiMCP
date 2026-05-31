// Electron main process.
// Owns the only privileged surface: filesystem, child processes, Credential Manager.
// The renderer talks to these ONLY through the typed IPC channels registered below.

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");

const credentials = require("./services/credentials");
const accounts = require("./services/accounts");
const serverManager = require("./services/serverManager");
const claudeConfig = require("./services/claudeConfig");
const log = require("./services/logger");

const isDev = !app.isPackaged;

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 880,
    minHeight: 600,
    backgroundColor: "#0e1116",
    title: "Google Workspace Manager",
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

  // Force OAuth / external links into the system browser, never an Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

// Wrap ipcMain.handle so every call is logged (args redacted) with its outcome
// and timing. Errors are logged and re-thrown so the renderer still sees them.
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

// --- IPC: credentials -------------------------------------------------------
handle("creds:get", () => credentials.getClientConfig());
handle("creds:save", ({ clientId, clientSecret }) =>
  credentials.saveClientConfig(clientId, clientSecret)
);

// --- IPC: prerequisites -----------------------------------------------------
handle("prereq:check", () => serverManager.checkPrerequisites());

// --- IPC: accounts ----------------------------------------------------------
handle("accounts:list", () => accounts.listAccounts());
handle("accounts:add", ({ email }) => accounts.addAccount(email));
handle("accounts:remove", ({ email }) => accounts.removeAccount(email));
handle("accounts:authorize", ({ email }) => serverManager.authorizeAccount(email));

// --- IPC: claude config -----------------------------------------------------
handle("claude:status", () => claudeConfig.getStatus());
handle("claude:write", () => claudeConfig.writeServerEntry());

// --- IPC: diagnostics -------------------------------------------------------
handle("server:test", () => serverManager.testServer());
handle("debug:get", () => ({
  logPath: log.getLogPath(),
  versions: process.versions,
  platform: process.platform,
}));
handle("debug:revealLog", () => {
  const p = log.getLogPath();
  if (p) shell.showItemInFolder(p);
  return { ok: !!p, path: p };
});

app.whenReady().then(() => {
  log.init();
  log.info("app", "app ready", { isDev, version: app.getVersion() });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

process.on("uncaughtException", (err) =>
  log.error("process", "uncaughtException", { message: String(err), stack: err && err.stack })
);
process.on("unhandledRejection", (reason) =>
  log.error("process", "unhandledRejection", { reason: String(reason) })
);

app.on("window-all-closed", () => {
  // Ensure any transient sign-in server is stopped.
  serverManager.stopAll().finally(() => {
    if (process.platform !== "darwin") app.quit();
  });
});
