// Electron main process.
// Owns the only privileged surface: filesystem, child processes, Credential Manager.
// The renderer talks to these ONLY through the typed IPC channels registered below.

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");

const credentials = require("./services/credentials");
const accounts = require("./services/accounts");
const serverManager = require("./services/serverManager");
const claudeConfig = require("./services/claudeConfig");

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

// --- IPC: credentials -------------------------------------------------------
ipcMain.handle("creds:get", async () => credentials.getClientConfig());
ipcMain.handle("creds:save", async (_e, { clientId, clientSecret }) =>
  credentials.saveClientConfig(clientId, clientSecret)
);

// --- IPC: prerequisites -----------------------------------------------------
ipcMain.handle("prereq:check", async () => serverManager.checkPrerequisites());

// --- IPC: accounts ----------------------------------------------------------
ipcMain.handle("accounts:list", async () => accounts.listAccounts());
ipcMain.handle("accounts:add", async (_e, { email }) => accounts.addAccount(email));
ipcMain.handle("accounts:remove", async (_e, { email }) => accounts.removeAccount(email));
ipcMain.handle("accounts:authorize", async (_e, { email }) =>
  serverManager.authorizeAccount(email)
);

// --- IPC: claude config -----------------------------------------------------
ipcMain.handle("claude:status", async () => claudeConfig.getStatus());
ipcMain.handle("claude:write", async () => claudeConfig.writeServerEntry());

// --- IPC: diagnostics -------------------------------------------------------
ipcMain.handle("server:test", async () => serverManager.testServer());

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // Ensure any transient sign-in server is stopped.
  serverManager.stopAll().finally(() => {
    if (process.platform !== "darwin") app.quit();
  });
});
