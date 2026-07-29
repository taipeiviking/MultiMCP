// Telegram connector service (Telethon-based).
//
// Same division of labor as signal.js: this tray app handles the ONE-TIME
// setup (the user's my.telegram.org api_id/api_hash, then phone + login code)
// and status; the AI clients launch their own MCP servers
// (python/multimcp-telegram) against the shared session.
//
// SINGLE-WRITER CONSTRAINT, Telegram edition: a Telethon session file must
// never be used by two processes (Telegram revokes duplicated auth keys). So
// ONE daemon (multimcp-telegram-daemon) owns the session on pinned port 7584,
// and everyone — including this file's login flow — is a JSON-RPC client that
// connects first and spawns the daemon only if nothing answers.
//
// The api_hash is a secret: Windows Credential Manager via keytar, like the
// Google client secret. It is injected into the written client configs for the
// same reason (documented exposure) as GOOGLE_OAUTH_CLIENT_SECRET.

const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const keytar = require("keytar");
const credentials = require("./credentials");
const serverManager = require("./serverManager");
const log = require("./logger");

const KEYTAR_SERVICE = "google-workspace-manager";
const KEYTAR_HASH_KEY = "telegram_api_hash";

// Pinned daemon port: 7583 is Signal's, 7584 is Telegram's.
const TELEGRAM_DAEMON_PORT = 7584;
const RPC_TIMEOUT_MS = 60000;

function dataDir() {
  const s = credentials.readSettings();
  return s.telegramDataDir || path.join(os.homedir(), ".multimcp", "telegram");
}

function serverSrcPath() {
  const candidates = [];
  try {
    const { app } = require("electron");
    if (app.isPackaged && process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, "mcp-telegram"));
    }
  } catch {
    /* not in electron */
  }
  candidates.push(path.join(__dirname, "..", "..", "python", "multimcp-telegram"));
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "pyproject.toml"))) return c;
  }
  return null;
}

async function uvPath() {
  const uvx = await serverManager.resolveUvxPath();
  if (!uvx) return null;
  const uv = path.join(path.dirname(uvx), process.platform === "win32" ? "uv.exe" : "uv");
  return fs.existsSync(uv) ? uv : null;
}

async function getApiCreds() {
  const s = credentials.readSettings();
  const apiHash = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_HASH_KEY);
  return { apiId: s.telegramApiId || "", apiHash: apiHash || "" };
}

async function saveApiCreds(apiId, apiHash) {
  credentials.patchSettings({ telegramApiId: String(apiId || "").trim() });
  if (apiHash) await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_HASH_KEY, apiHash.trim());
  log.info("telegram", "API credentials saved", { apiIdSet: !!apiId, hashUpdated: !!apiHash });
  return { ok: true };
}

async function daemonEnv() {
  const { apiId, apiHash } = await getApiCreds();
  return Object.assign({}, process.env, {
    TELEGRAM_API_ID: apiId,
    TELEGRAM_API_HASH: apiHash,
    TELEGRAM_SESSION_DIR: dataDir(),
    TELEGRAM_DAEMON_PORT: String(TELEGRAM_DAEMON_PORT),
  });
}

// The windowless Python in the project's uv-managed venv. pythonw.exe never
// allocates a console — the fix for the daemon flashing a terminal window.
// (The MCP SERVER still launches via `uv run` python.exe, because it speaks
// MCP over stdio and pythonw has no stdio; the daemon needs no stdio.)
function venvPythonw(src) {
  const p = path.join(src, ".venv", "Scripts", process.platform === "win32" ? "pythonw.exe" : "python");
  return fs.existsSync(p) ? p : null;
}

// Spawn the shared daemon detached and truly windowless. Prefer the venv's
// pythonw.exe (no console ever); fall back to `uv run` only if the venv is not
// synced yet (prewarm normally makes it before this runs). The editable install
// means source changes are live either way — no staleness like uvx had.
async function spawnDaemon() {
  const uv = await uvPath();
  const src = serverSrcPath();
  if (!src) return false;
  fs.mkdirSync(path.join(dataDir()), { recursive: true });
  const out = fs.openSync(path.join(dataDir(), "daemon.log"), "a");
  try {
    const pw = venvPythonw(src);
    const [cmd, args] = pw
      ? [pw, ["-m", "multimcp_telegram.daemon"]]
      : uv
        ? [uv, ["run", "--project", src, "multimcp-telegram-daemon"]]
        : [null, null];
    if (!cmd) return false;
    const child = spawn(cmd, args, {
      cwd: src, // so `-m multimcp_telegram.daemon` resolves against the package
      env: await daemonEnv(),
      detached: true,
      stdio: ["ignore", out, out],
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch (e) {
    log.warn("telegram", "daemon spawn failed", { message: String(e) });
    return false;
  } finally {
    fs.closeSync(out);
  }
}

// Returns a CONNECTED socket with no lingering inactivity timeout, or null if
// the connect attempt fails/stalls. The 2s timeout bounds the CONNECT ONLY —
// it MUST be cleared once connected, or it later fires mid-RPC and destroys the
// socket while the daemon is still doing a network round-trip to Telegram (the
// bug that made start_login "stick": send_code_request takes >2s, the socket
// self-destructed, the reply never arrived).
function connectOnce() {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port: TELEGRAM_DAEMON_PORT });
    const fail = () => {
      s.destroy();
      resolve(null);
    };
    s.once("connect", () => {
      s.setTimeout(0); // disable the inactivity timeout for the RPC lifetime
      s.removeListener("error", fail); // later errors belong to the RPC handler
      resolve(s);
    });
    s.once("error", fail);
    s.setTimeout(2000, fail);
  });
}

// Ensure exactly ONE daemon is listening, spawning it at most once even when
// several rpc() calls arrive together. Without this guard, concurrent callers
// (e.g. a status poll firing alongside startLogin) each spawned their own
// daemon; the second crashed opening the shared session file ("table version
// already exists") and wedged the login. A module-level spawn promise
// serializes it: concurrent callers await the same spawn.
let spawnGuard = null;
async function ensureDaemonListening() {
  const probe = await connectOnce();
  if (probe) {
    probe.destroy();
    return;
  }
  if (!spawnGuard) {
    spawnGuard = (async () => {
      if (!(await spawnDaemon())) throw new Error("The Telegram engine could not be started (uv or server source missing).");
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const s = await connectOnce();
        if (s) {
          s.destroy();
          return;
        }
      }
      throw new Error("The Telegram engine did not start — see daemon.log in the Telegram data dir.");
    })().finally(() => {
      spawnGuard = null;
    });
  }
  await spawnGuard;
}

// One-shot RPC: ensure the (single) daemon is up, connect, send one request,
// await the response, close. Login is a low-frequency flow; simplicity beats a
// pooled connection here.
async function rpc(method, params = {}) {
  await ensureDaemonListening();
  const sock = await connectOnce();
  if (!sock) throw new Error("The Telegram engine did not answer — see daemon.log in the Telegram data dir.");
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`Telegram engine did not answer ${method} in time.`));
    }, RPC_TIMEOUT_MS);
    sock.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      clearTimeout(timer);
      sock.destroy();
      try {
        const resp = JSON.parse(buf.slice(0, i));
        if (resp.error) reject(new Error(resp.error.message || "Telegram error"));
        else resolve(resp.result);
      } catch (e) {
        reject(e);
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
  });
}

async function getStatus() {
  const { apiId, apiHash } = await getApiCreds();
  const configured = !!(apiId && apiHash);
  const s = credentials.readSettings();
  const base = {
    configured,
    serverSrc: serverSrcPath(),
    dataDir: dataDir(),
    daemonPort: TELEGRAM_DAEMON_PORT,
    account: s.telegramAccount || null,
    authorized: !!s.telegramAccount,
  };
  if (!configured) return base;
  // Ask the daemon for live truth when we can; fall back to the cached value
  // (the daemon may take seconds to boot — the UI polls again anyway).
  try {
    const st = await rpc("status");
    if (st.authorized && st.user) {
      const account = st.user.phone || st.user.username || st.user.name;
      if (account && account !== s.telegramAccount) credentials.patchSettings({ telegramAccount: account });
      return Object.assign(base, { authorized: true, account, user: st.user });
    }
    return Object.assign(base, { authorized: false, account: null });
  } catch (e) {
    return Object.assign(base, { engineError: String(e.message || e) });
  }
}

const startLogin = (phone) => rpc("start_login", { phone });
const submitCode = async (code) => {
  const r = await rpc("submit_code", { code });
  if (r.authorized) await getStatus(); // caches telegramAccount
  return r;
};
const submitPassword = async (password) => {
  const r = await rpc("submit_password", { password });
  if (r.authorized) await getStatus();
  return r;
};

function killDaemon() {
  return new Promise((resolve) => {
    const { execFile } = require("child_process");
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-NetTCPConnection -LocalPort ${TELEGRAM_DAEMON_PORT} -State Listen -ErrorAction SilentlyContinue | ` +
          `ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -Confirm:$false }`,
      ],
      { windowsHide: true },
      () => resolve()
    );
  });
}

async function unlink() {
  try {
    await rpc("logout"); // invalidates the session server-side too
  } catch {
    /* daemon not up / already logged out — proceed with local cleanup */
  }
  await killDaemon();
  try {
    fs.rmSync(dataDir(), { recursive: true, force: true });
  } catch (e) {
    return { ok: false, error: `Could not remove ${dataDir()}: ${e}` };
  }
  credentials.patchSettings({ telegramAccount: null });
  log.info("telegram", "unlinked (logged out, local session removed)");
  return { ok: true };
}

// Env keys whose drift makes a written client-config entry stale.
const CRITICAL_ENV = ["TELEGRAM_API_ID", "TELEGRAM_SESSION_DIR", "TELEGRAM_DAEMON_PORT"];

async function buildEntryParts() {
  const { apiId, apiHash } = await getApiCreds();
  const s = credentials.readSettings();
  const src = serverSrcPath();
  const uv = await uvPath();
  if (!apiId || !apiHash || !s.telegramAccount || !src || !uv) return null;
  return {
    command: uv,
    args: ["run", "--project", src, "multimcp-telegram"],
    env: {
      TELEGRAM_API_ID: apiId,
      TELEGRAM_API_HASH: apiHash,
      TELEGRAM_SESSION_DIR: dataDir(),
      TELEGRAM_DAEMON_PORT: String(TELEGRAM_DAEMON_PORT),
    },
  };
}

// Sync the telegram package's venv once, windowless, at app startup — so the
// first real daemon spawn doesn't pay the ~30s uv-sync cost (which is what
// flashed a console window on first use). Best-effort and quiet.
async function prewarm() {
  const uv = await uvPath();
  const src = serverSrcPath();
  if (!uv || !src) return;
  try {
    const child = spawn(uv, ["sync", "--project", src], { windowsHide: true, stdio: "ignore", detached: false });
    child.on("error", () => {});
  } catch {
    /* best effort */
  }
}

module.exports = {
  getStatus,
  saveApiCreds,
  prewarm,
  startLogin,
  submitCode,
  submitPassword,
  unlink,
  buildEntryParts,
  dataDir,
  CRITICAL_ENV,
  TELEGRAM_DAEMON_PORT,
};
