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
  app: {
    version: () => ipcRenderer.invoke("app:version"),
  },
  accounts: {
    list: () => ipcRenderer.invoke("accounts:list"),
    add: (email) => ipcRenderer.invoke("accounts:add", { email }),
    remove: (email) => ipcRenderer.invoke("accounts:remove", { email }),
    setLabel: (email, label) => ipcRenderer.invoke("accounts:setLabel", { email, label }),
    authorize: (email) => ipcRenderer.invoke("accounts:authorize", { email }),
    verify: () => ipcRenderer.invoke("accounts:verify"),
  },
  claude: {
    status: () => ipcRenderer.invoke("claude:status"),
    write: () => ipcRenderer.invoke("claude:write"),
  },
  codex: {
    status: () => ipcRenderer.invoke("codex:status"),
    write: () => ipcRenderer.invoke("codex:write"),
  },
  guidance: {
    status: (client) => ipcRenderer.invoke("guidance:status", { client }),
    apply: (client, targetKey) => ipcRenderer.invoke("guidance:apply", { client, targetKey }),
  },
  signal: {
    status: () => ipcRenderer.invoke("signal:status"),
    link: () => ipcRenderer.invoke("signal:link"),
    cancelLink: () => ipcRenderer.invoke("signal:linkCancel"),
    unlink: () => ipcRenderer.invoke("signal:unlink"),
    captureStatus: () => ipcRenderer.invoke("signal:captureStatus"),
    // The link URI arrives mid-flow (link() is still pending when it does), so it
    // comes as an event. Returns an unsubscribe function; no raw ipcRenderer leaks.
    onLinkUri: (cb) => {
      const listener = (_e, uri) => cb(uri);
      ipcRenderer.on("signal:linkUri", listener);
      return () => ipcRenderer.removeListener("signal:linkUri", listener);
    },
  },
  server: {
    test: () => ipcRenderer.invoke("server:test"),
  },
  debug: {
    get: () => ipcRenderer.invoke("debug:get"),
    readLog: () => ipcRenderer.invoke("debug:readLog"),
  },
  autostart: {
    get: () => ipcRenderer.invoke("autostart:get"),
    set: (enabled) => ipcRenderer.invoke("autostart:set", { enabled }),
  },
  prefs: {
    get: () => ipcRenderer.invoke("prefs:get"),
    set: (productionMode) => ipcRenderer.invoke("prefs:set", { productionMode }),
  },
  help: {
    open: () => ipcRenderer.invoke("help:open"),
    openDoc: (key) => ipcRenderer.invoke("docs:open", { key }),
  },
  backup: {
    export: () => ipcRenderer.invoke("backup:export"),
    pick: () => ipcRenderer.invoke("backup:pick"),
    import: (path, overwrite) =>
      ipcRenderer.invoke("backup:import", { path, overwrite }),
  },
});
