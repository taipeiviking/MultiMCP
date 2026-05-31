// Preload: the ONLY bridge between the sandboxed renderer and the main process.
// Expose a small, explicit, typed surface. No fs, no child_process, no ipcRenderer
// leakage into the page.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  credentials: {
    get: () => ipcRenderer.invoke("creds:get"),
    save: (clientId, clientSecret) =>
      ipcRenderer.invoke("creds:save", { clientId, clientSecret }),
  },
  prereqs: {
    check: () => ipcRenderer.invoke("prereq:check"),
  },
  accounts: {
    list: () => ipcRenderer.invoke("accounts:list"),
    add: (email) => ipcRenderer.invoke("accounts:add", { email }),
    remove: (email) => ipcRenderer.invoke("accounts:remove", { email }),
    authorize: (email) => ipcRenderer.invoke("accounts:authorize", { email }),
  },
  claude: {
    status: () => ipcRenderer.invoke("claude:status"),
    write: () => ipcRenderer.invoke("claude:write"),
  },
  server: {
    test: () => ipcRenderer.invoke("server:test"),
  },
  debug: {
    get: () => ipcRenderer.invoke("debug:get"),
    revealLog: () => ipcRenderer.invoke("debug:revealLog"),
    readLog: () => ipcRenderer.invoke("debug:readLog"),
    copyLogPath: () => ipcRenderer.invoke("debug:copyLogPath"),
  },
  autostart: {
    get: () => ipcRenderer.invoke("autostart:get"),
    set: (enabled) => ipcRenderer.invoke("autostart:set", { enabled }),
  },
  help: {
    open: () => ipcRenderer.invoke("help:open"),
  },
});
