// Signal messenger service.
//
// Mirrors the Google flow one-to-one: this tray app performs the ONE-TIME link
// (Signal's analog of an OAuth sign-in — a QR code scanned from the phone) and
// keeps shared state in a fixed data dir; the MCP server that Claude/Codex
// launches (python/multimcp-signal, via the bundled uvx) reads that same dir.
//
// The engine is signal-cli (https://github.com/AsamK/signal-cli), vendored by
// scripts/fetch-signal.js together with a Temurin JRE — the user installs
// nothing, same bar as the bundled uv. Everything here degrades gracefully when
// the engine is not vendored (dev checkouts before running fetch-signal): the
// UI shows an explanation instead of a dead button, and no config entry is
// offered.
//
// SINGLE-WRITER CONSTRAINT (the design risk that shapes the MCP server):
// signal-cli locks its data dir — two processes cannot use the account at once.
// Claude and Codex each spawn their own MCP server, so the servers follow a
// connect-first/spawn-if-absent protocol on ONE localhost JSON-RPC daemon at a
// pinned port. This file must respect the same lock: the interactive link runs
// only when we hold the dir, so link() refuses while a daemon holds it.

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const credentials = require("./credentials");
const serverManager = require("./serverManager");
const log = require("./logger");

// Pinned localhost port for the signal-cli JSON-RPC daemon. Like the 8000/9000/
// 9001 split for the Google servers, this is load-bearing, not tidiness: every
// MCP server instance (Claude's, Codex's) must agree on it to share ONE daemon
// instead of fighting over the data-dir lock.
const SIGNAL_DAEMON_PORT = 7583;

// How long we wait for the user to scan the QR code. Same generosity (and the
// same reasoning) as serverManager.SIGNIN_TIMEOUT_MS: finding Settings →
// Linked devices on a phone routinely takes minutes.
const LINK_TIMEOUT_MS = 600000; // 10 minutes

// Shared Signal state, analogous to credentials.credentialsDir(). Deliberately
// under the home dir (not Electron userData): the path lands verbatim in the
// client configs, and userData moves if the app is ever renamed.
function dataDir() {
  const s = credentials.readSettings();
  return s.signalDataDir || path.join(os.homedir(), ".multimcp", "signal");
}

// --- Vendored engine paths ---------------------------------------------------
// Same resolution order as serverManager.bundledUvxPath(): packaged resources
// first, then the repo's vendor dir for dev.

function vendorRoot() {
  const candidates = [];
  try {
    const { app } = require("electron");
    if (app.isPackaged && process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, "signal"));
    }
  } catch {
    /* electron not ready / not available */
  }
  candidates.push(path.join(__dirname, "..", "..", "vendor", "signal"));
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

// The vendored archives keep their VERSIONED dir names (signal-cli-0.14.6/,
// jdk-21.x.y+z-jre/) — fetch-signal.js deliberately does not rename them,
// because Defender holds handles on freshly extracted binaries and fails the
// rename for minutes. So resolve by prefix, newest first ("signal-cli"/"jre"
// still accepted for compatibility with trees flattened by older builds).
function locateVendored(prefixes, probeRel) {
  const root = vendorRoot();
  if (!root) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return null;
  }
  const matches = entries
    .filter((e) => prefixes.some((p) => e === p || e.startsWith(p)))
    .sort()
    .reverse();
  for (const e of matches) {
    const dir = path.join(root, e);
    if (fs.existsSync(path.join(dir, probeRel))) return dir;
  }
  return null;
}

function signalCliPath() {
  const launcher = process.platform === "win32" ? "signal-cli.bat" : "signal-cli";
  const dir = locateVendored(["signal-cli"], path.join("bin", launcher));
  return dir ? path.join(dir, "bin", launcher) : null;
}

function javaHomePath() {
  const javaExe = path.join("bin", process.platform === "win32" ? "java.exe" : "java");
  return locateVendored(["jre", "jdk-"], javaExe);
}

// The multimcp-signal MCP server source, shipped as an app resource so the
// bundled uvx can run it with `--from` (mirrors how workspace-mcp is launched,
// minus PyPI). Dev fallback: the in-repo python/ package.
function serverSrcPath() {
  const candidates = [];
  try {
    const { app } = require("electron");
    if (app.isPackaged && process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, "mcp-signal"));
    }
  } catch {
    /* ignore */
  }
  candidates.push(path.join(__dirname, "..", "..", "python", "multimcp-signal"));
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, "pyproject.toml"))) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function engineStatus() {
  const cli = signalCliPath();
  const jre = javaHomePath();
  const src = serverSrcPath();
  return {
    ok: !!(cli && jre && src),
    signalCli: cli,
    javaHome: jre,
    serverSrc: src,
  };
}

// --- Running signal-cli ------------------------------------------------------

// How to actually start signal-cli. On Windows we do NOT use the shipped .bat:
// it expands a ~100-jar CLASSPATH inline, and from the installed app's long
// path that line exceeds cmd.exe's 8191-char limit — "The input line is too
// long", engine never starts (observed live; the short repo path had masked
// it). Invoke java directly with a wildcard classpath, which JAVA expands.
// Non-Windows keeps the sh launcher (no such limit).
function javaInvocation(args) {
  const cli = signalCliPath();
  const jre = javaHomePath();
  if (!cli || !jre) throw new Error("Signal engine is not vendored (run: npm run fetch-signal)");
  const full = ["--config", dataDir(), ...args];
  if (process.platform === "win32") {
    const libDir = path.join(path.dirname(path.dirname(cli)), "lib");
    return {
      exe: path.join(jre, "bin", "java.exe"),
      args: ["-classpath", `${libDir}\\*`, "org.asamk.signal.Main", ...full],
      env: Object.assign({}, process.env, { JAVA_HOME: jre }),
    };
  }
  return { exe: cli, args: full, env: Object.assign({}, process.env, { JAVA_HOME: jre }) };
}

function spawnSignalCli(args, extra = {}) {
  const inv = javaInvocation(args);
  return spawn(inv.exe, inv.args, { env: inv.env, windowsHide: true, ...extra });
}

// Run to completion, capturing output. Rejects only on spawn failure; a nonzero
// exit resolves with { code, stdout, stderr } so callers can read the reason.
function runSignalCli(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnSignalCli(args);
    } catch (e) {
      return reject(e);
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill();
      } catch {}
      resolve({ code: null, timedOut: true, stdout, stderr });
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// Is the shared JSON-RPC daemon (spawned by an MCP server) currently running?
// While it is, IT holds the data-dir lock, so an interactive link cannot run.
function daemonRunning() {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port: SIGNAL_DAEMON_PORT });
    const finish = (up) => {
      try {
        sock.destroy();
      } catch {}
      resolve(up);
    };
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
    sock.setTimeout(1500, () => finish(false));
  });
}

// --- Account state -----------------------------------------------------------

// The linked phone number is cached in settings the moment linking succeeds, so
// status stays instant (a JVM start for listAccounts costs seconds). listAccounts
// is only consulted when the cache is empty (e.g. settings were imported).
async function listAccounts() {
  const r = await runSignalCli(["listAccounts"], { timeoutMs: 90000 });
  if (r.timedOut || r.code !== 0) return [];
  // Output: one line per account, "Number: +4917012345678"
  return [...r.stdout.matchAll(/Number:\s*(\+\d+)/g)].map((m) => m[1]);
}

async function getStatus() {
  const engine = engineStatus();
  const s = credentials.readSettings();
  let account = s.signalAccount || null;
  const dirExists = fs.existsSync(path.join(dataDir(), "data"));
  if (!account && engine.ok && dirExists && !(await daemonRunning())) {
    const found = await listAccounts().catch(() => []);
    if (found.length) {
      account = found[0];
      credentials.patchSettings({ signalAccount: account });
    }
  }
  return {
    engine,
    linked: !!account && dirExists,
    account,
    dataDir: dataDir(),
    daemonPort: SIGNAL_DAEMON_PORT,
  };
}

// --- Linking -----------------------------------------------------------------

let linkChild = null; // at most one interactive link at a time

// Start `signal-cli link -n MultiMCP`. It prints ONE line — the
// sgnl://linkdevice?... URI — then blocks until the phone scans it (then syncs
// and exits 0). onUri fires as soon as the URI is known so the renderer can show
// the QR; the returned promise settles when linking finishes or times out.
async function link({ onUri } = {}) {
  const engine = engineStatus();
  if (!engine.ok) {
    return { ok: false, error: "The Signal engine is not bundled in this build." };
  }
  if (linkChild) return { ok: false, error: "A link attempt is already running." };
  if (await daemonRunning()) {
    // The daemon holds the data-dir lock. Asking the user to quit their AI apps
    // beats failing with signal-cli's opaque lock error.
    return {
      ok: false,
      error:
        "Signal is busy (an AI client is using it right now). Quit Claude Desktop/Codex and try again.",
    };
  }

  fs.mkdirSync(dataDir(), { recursive: true });
  const child = spawnSignalCli(["link", "-n", "MultiMCP"]);
  linkChild = child;

  return new Promise((resolve) => {
    let uriSent = false;
    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      linkChild = null;
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      settle({ ok: false, timedOut: true, error: "Timed out waiting for the phone to scan." });
    }, LINK_TIMEOUT_MS);

    child.stdout.on("data", (d) => {
      stdout += d;
      if (!uriSent) {
        const m = stdout.match(/sgnl:\/\/linkdevice\S+/);
        if (m) {
          uriSent = true;
          log.info("signal", "link URI ready (QR shown to user)");
          if (onUri) onUri(m[0]);
        }
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => settle({ ok: false, error: String(e) }));
    child.on("close", async (code) => {
      if (code !== 0) {
        log.warn("signal", "link failed", { code, stderr: stderr.slice(-2000) });
        return settle({
          ok: false,
          error: stderr.trim().split(/\r?\n/).pop() || `signal-cli exited with code ${code}`,
        });
      }
      // Linked. Ask signal-cli which number this is and cache it.
      const accounts = await listAccounts().catch(() => []);
      const account = accounts[0] || null;
      if (account) credentials.patchSettings({ signalAccount: account });
      log.info("signal", "linked", { account });
      settle({ ok: true, account });
    });
  });
}

function cancelLink() {
  if (!linkChild) return { ok: true, wasRunning: false };
  try {
    linkChild.kill();
  } catch {}
  linkChild = null;
  return { ok: true, wasRunning: true };
}

// Kill whatever owns the daemon port. Used by unlink: the daemon holds the
// data-dir lock (and since the tray app keeps one alive at all times, "wait
// until nothing is running" would never come). Ending it is the point — the
// user is disconnecting Signal.
function killDaemon() {
  return new Promise((resolve) => {
    const { execFile } = require("child_process");
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-NetTCPConnection -LocalPort ${SIGNAL_DAEMON_PORT} -State Listen -ErrorAction SilentlyContinue | ` +
          `ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -Confirm:$false }`,
      ],
      { windowsHide: true },
      () => resolve()
    );
  });
}

// Unlink = forget the local device state. The phone keeps listing "MultiMCP"
// under Linked devices until the user removes it there; deliberately NOT
// `unregister`, which would disable the user's whole Signal account.
async function unlink() {
  await killDaemon();
  cancelLink();
  const dir = dataDir();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, error: `Could not remove ${dir}: ${e}` };
  }
  credentials.patchSettings({ signalAccount: null });
  log.info("signal", "unlinked (local state removed)", { dir });
  return {
    ok: true,
    note: "Also remove “MultiMCP” on your phone: Signal → Settings → Linked devices.",
  };
}

// --- Client config entries ---------------------------------------------------
// Consumed by claudeConfig/codexConfig. Returns null when there is nothing to
// write (not linked, or the engine/server source is missing) — the writers then
// REMOVE any stale MultiMCP-Signal entry, keeping configs truthful.

// Env keys that must match for an existing entry to count as up to date
// (same contract as claudeConfig.CRITICAL_ENV).
const CRITICAL_ENV = [
  "SIGNAL_ACCOUNT",
  "SIGNAL_CLI_PATH",
  "SIGNAL_JAVA_HOME",
  "SIGNAL_CONFIG_DIR",
  "SIGNAL_DAEMON_PORT",
];

async function buildEntryParts() {
  const engine = engineStatus();
  const s = credentials.readSettings();
  const account = s.signalAccount;
  if (!engine.ok || !account) return null;
  const uvxPath = await serverManager.resolveUvxPath();
  // uv.exe ships next to uvx.exe in the bundled dir. `uv run --project` (NOT
  // `uvx --from`): uvx caches the built tool env and serves STALE code after
  // the source changes — observed live: three fixes silently not running, and
  // it would equally pin users to the old server across app upgrades. uv run
  // installs the project editable and re-syncs on every launch.
  const uvPath = uvxPath
    ? path.join(path.dirname(uvxPath), process.platform === "win32" ? "uv.exe" : "uv")
    : null;
  return {
    command: uvPath && fs.existsSync(uvPath) ? uvPath : "uv",
    args: ["run", "--project", engine.serverSrc, "multimcp-signal"],
    env: {
      SIGNAL_ACCOUNT: account,
      SIGNAL_CLI_PATH: engine.signalCli,
      SIGNAL_JAVA_HOME: engine.javaHome,
      SIGNAL_CONFIG_DIR: dataDir(),
      SIGNAL_DAEMON_PORT: String(SIGNAL_DAEMON_PORT),
    },
  };
}

module.exports = {
  getStatus,
  link,
  cancelLink,
  unlink,
  buildEntryParts,
  engineStatus,
  dataDir,
  javaInvocation,
  CRITICAL_ENV,
  SIGNAL_DAEMON_PORT,
};
