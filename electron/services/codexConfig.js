// OpenAI Codex CLI config service.
//
// Merges our MCP server entry into ~/.codex/config.toml (or $CODEX_HOME/config.toml)
// without disturbing the user's model, approval policy, other MCP servers, or
// their comments. The TOML text surgery lives in tomlEdit.js; this file is the
// policy: what we write, when we write it, and how we refuse.
//
// See claudeConfig.js for the equivalent Claude Desktop service. The two are
// deliberately parallel (SERVER_KEY, buildEntry, getStatus, writeServerEntry,
// healServerEntryIfStale) so a change to the env can be applied to both.

const fs = require("fs");
const os = require("os");
const path = require("path");
const credentials = require("./credentials");
const serverManager = require("./serverManager");
const noBrowser = require("./noBrowser");
const tomlEdit = require("./tomlEdit");
const log = require("./logger");

const SERVER_KEY = "MultiMCP";
const TABLE_PATH = ["mcp_servers", SERVER_KEY]; // note: Codex uses mcp_servers (underscore)

// Codex gets its OWN port, distinct from BOTH the tray app's interactive sign-in
// port (serverManager.SIGNIN_PORT = 8000) and Claude Desktop's background server
// (claudeConfig CLAUDE_MCP_PORT = 9000).
//
// This is not tidiness, it is required. EACH MCP CLIENT SPAWNS ITS OWN SERVER
// PROCESS. If Codex and Claude are both running, two workspace-mcp processes
// exist at once. Give them the same port and the second one to start silently
// falls back to another port (e.g. 8002) -- and an OAuth flow on an unregistered
// port dies with redirect_uri_mismatch. Worse, a fallback could land on 8000 and
// steal the tray app's registered sign-in port.
//
// Like 9000, port 9001 is deliberately NOT a registered redirect URI in Google
// Cloud, and must stay that way. It is the same safety interlock: if a background
// server ever does start an OAuth flow, that flow must be incapable of completing.
const CODEX_MCP_PORT = 9001;

// A single marker comment above the block we write, so the user can see at a glance
// which part of their file is ours.
//
// There is deliberately NO closing sentinel. The Codex desktop app rewrites
// config.toml on every launch (it re-injects its own node_repl server), and its TOML
// writer reorders tables -- which orphans a trailing marker and migrates it to the
// end of the file, where it becomes litter we can never find again to remove.
// Removing our block is done STRUCTURALLY (by table path), not by matching markers,
// so the closing sentinel bought nothing and cost that.
const SENTINELS = {
  begin: "# >>> MultiMCP (managed by Google Workspace Manager) - regenerated on write, do not edit",
};

// Env keys that must match for an existing entry to count as up to date. Same
// contract as claudeConfig.CRITICAL_ENV: anything load-bearing MUST be listed, or
// existing installs keep a stale entry forever.
const CRITICAL_ENV = [
  "MCP_SINGLE_USER_MODE",
  "BROWSER",
  "WORKSPACE_MCP_PORT",
  "GOOGLE_MCP_CREDENTIALS_DIR",
  "GOOGLE_OAUTH_CLIENT_ID",
];

// Codex honours CODEX_HOME; default is ~/.codex.
function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function configPath() {
  return path.join(codexHome(), "config.toml");
}

function readRaw() {
  try {
    return fs.readFileSync(configPath(), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return "";
    throw e; // locked / permissions: do NOT pretend the file is empty and overwrite it
  }
}

// The desired entry, as the plain object we expect to read back after parsing.
// Shares every hard-won env decision with claudeConfig.buildEntry(); see the long
// comments there for MCP_SINGLE_USER_MODE and BROWSER, both of which are the
// difference between "works" and "throws a browser tab per account".
async function buildEntry() {
  const { clientId, credentialsDir } = await credentials.getClientConfig();
  const clientSecret = await credentials.getClientSecret();
  const uvxPath = await serverManager.resolveUvxPath();

  const settings = credentials.readSettings();
  const injectSecret = settings.injectSecretIntoConfig !== false;

  const env = {
    GOOGLE_OAUTH_CLIENT_ID: clientId,
    GOOGLE_MCP_CREDENTIALS_DIR: credentialsDir,
    WORKSPACE_MCP_CREDENTIALS_DIR: credentialsDir,
    OAUTHLIB_INSECURE_TRANSPORT: "1",
    WORKSPACE_MCP_PORT: String(CODEX_MCP_PORT),
    PORT: String(CODEX_MCP_PORT),
    WORKSPACE_MCP_BASE_URI: "http://localhost",
    MCP_SINGLE_USER_MODE: "1",
  };
  if (injectSecret) env.GOOGLE_OAUTH_CLIENT_SECRET = clientSecret || "";

  const shim = noBrowser.shimPathIfPresent();
  if (shim) env.BROWSER = shim;

  const scalars = {
    command: uvxPath || "uvx",
    args: ["workspace-mcp", "--tools", "gmail", "drive", "calendar"],
    // Codex's default startup timeout is 10s. A cold uvx start resolves and
    // downloads ~90 packages (and Defender scans them), which blows straight
    // through that, and Codex kills the server before it ever finishes booting.
    // 120s matches what Codex itself uses for its own bundled node_repl server.
    startup_timeout_sec: 120,
    // Default tool timeout is 60s; a Gmail batch fetch across several accounts
    // can exceed it.
    tool_timeout_sec: 300,
  };

  return { scalars, env, expected: Object.assign({}, scalars, { env }) };
}

async function writeServerEntry() {
  const p = configPath();
  const raw = readRaw(); // throws (rather than returning "") if the file is unreadable

  // A config.toml that does not parse is already broken for Codex, and every
  // assumption our scanner makes about it is void. Do not "fix" it and do not
  // write over it -- we would be guessing at the user's intent with their file.
  const oldParsed = raw.trim() ? tomlEdit.parseOrNull(raw) : {};
  if (oldParsed === null) {
    throw new Error(
      `${p} is not valid TOML, so it cannot be edited safely. Fix or remove the file and try again.`
    );
  }

  const { scalars, env, expected } = await buildEntry();

  // 1. Build the new text in memory. Throws TomlRefusal on a shape we cannot
  //    edit safely (root inline mcp_servers table).
  const edit = tomlEdit.upsertTable(raw, {
    path: TABLE_PATH,
    scalars,
    subTables: { env },
    sentinels: SENTINELS,
  });

  // 2. Validate BEFORE anything touches the disk. The happy path never needs the
  //    backup at all -- a bad edit is caught while the real file is still intact.
  const problems = tomlEdit.validateEdit(oldParsed, edit.text, TABLE_PATH, expected);
  if (problems.length) {
    log.error("codexConfig", "refusing to write: validation failed", { path: p, problems });
    throw new Error(`Refusing to write ${p}: ${problems.join("; ")}`);
  }

  // 3. Timestamped backup (claudeConfig.js convention).
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let backup = null;
  if (fs.existsSync(p)) {
    backup = `${p}.bak-${Date.now()}`;
    fs.copyFileSync(p, backup);
  }

  // 4. Atomic write (credentials.js convention): a plain writeFileSync truncates
  //    in place, so an unclean shutdown mid-write leaves a zero-length config.
  //    Write a temp file, fsync it, then rename over the primary (atomic on NTFS).
  const tmp = `${p}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, edit.text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);

  // 5. Re-read from DISK and validate again. Step 2 proved the string was good;
  //    this proves the bytes that actually landed are good (encoding, truncation,
  //    an AV product rewriting the file). Only here can a rollback be needed.
  const problemsOnDisk = tomlEdit.validateEdit(oldParsed, fs.readFileSync(p, "utf8"), TABLE_PATH, expected);
  if (problemsOnDisk.length) {
    if (backup) fs.copyFileSync(backup, p);
    else fs.unlinkSync(p); // we created it; leave the machine as we found it
    log.error("codexConfig", "post-write validation failed - rolled back", {
      path: p,
      backup,
      problems: problemsOnDisk,
    });
    throw new Error(`Wrote ${p} but it did not verify; restored the previous file. ${problemsOnDisk.join("; ")}`);
  }

  credentials.patchSettings({ codexConfigWritten: true });

  // A BOM is preserved, never silently stripped -- changing the user's file
  // encoding is not ours to do. But flag it: a UTF-8 BOM is a realistic Windows
  // accident (PowerShell 5.1's ">" and Out-File emit one by default), and a TOML
  // parser that rejects a BOM will fail on the whole file. If Codex reports a
  // broken config and this warning is in the log, the BOM is the first suspect.
  if (edit.bom) {
    log.warn("codexConfig", "config.toml starts with a UTF-8 BOM (preserved as-is)", {
      path: p,
      hint: "Some TOML parsers reject a leading BOM. If Codex cannot read this file, re-save it as UTF-8 without BOM.",
    });
  }

  log.info("codexConfig", "Wrote Codex config", {
    path: p,
    backup,
    key: SERVER_KEY,
    form: edit.form, // "header" (normal) or "dotted" (file already used dotted keys)
    replacedExisting: edit.replaced,
    eol: edit.eol === "\r\n" ? "CRLF" : "LF",
    bom: !!edit.bom,
    command: scalars.command,
    envKeys: Object.keys(env),
    secretInjected: Object.prototype.hasOwnProperty.call(env, "GOOGLE_OAUTH_CLIENT_SECRET"),
    browserSuppressed: !!env.BROWSER,
    preservedServers: Object.keys(oldParsed.mcp_servers || {}).filter((k) => k !== SERVER_KEY),
  });

  return { ok: true, path: p, note: "Restart Codex to load changes." };
}

function entryMatches(existing, expected) {
  if (!existing || !existing.env) return false;
  if (existing.command !== expected.command) return false;
  if (JSON.stringify(existing.args) !== JSON.stringify(expected.args)) return false;
  // Compare the timeouts NUMERICALLY, and do compare them at all: Codex's own TOML
  // writer re-emits `120` as `120.0`, so a string/strict compare would report a
  // healthy entry as stale forever (rewriting it on every launch). Omitting them
  // entirely - as the first draft did - has the opposite failure: an install with
  // the old 60s timeout would never be upgraded.
  if (Number(existing.startup_timeout_sec) !== Number(expected.startup_timeout_sec)) return false;
  if (Number(existing.tool_timeout_sec) !== Number(expected.tool_timeout_sec)) return false;
  return CRITICAL_ENV.every((k) => existing.env[k] === expected.env[k]);
}

// Is Codex on this machine at all? Used only to decide whether the UI shows the
// Codex section as actionable or as an explanation. Detection is deliberately
// generous (a config dir is enough): being wrong here must never block a user who
// has Codex from writing their config.
function detect() {
  const home = codexHome();
  const exe = findCodexExe();
  return {
    installed: fs.existsSync(home) || !!exe,
    home,
    // Codex ships its CLI inside the desktop app at a version-hashed path and does
    // NOT put it on PATH, so this is the binary the user needs for `codex mcp get`.
    exe,
  };
}

function findCodexExe() {
  const roots = [
    path.join(process.env.LOCALAPPDATA || "", "OpenAI", "Codex", "bin"),
    path.join(process.env.PROGRAMFILES || "", "OpenAI", "Codex", "bin"),
  ].filter((r) => r && fs.existsSync(r));
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      const candidate = path.join(root, e, "codex.exe");
      if (fs.existsSync(candidate)) return candidate;
    }
    const direct = path.join(root, "codex.exe");
    if (fs.existsSync(direct)) return direct;
  }
  return null;
}

async function getStatus() {
  const p = configPath();
  const { installed, exe } = detect();
  let raw;
  try {
    raw = readRaw();
  } catch (e) {
    return { installed, exe, present: false, inSync: false, path: p, error: String(e) };
  }
  const parsed = raw.trim() ? tomlEdit.parseOrNull(raw) : {};
  if (parsed === null) {
    return {
      installed,
      exe,
      present: false,
      inSync: false,
      path: p,
      error: "config.toml is not valid TOML",
    };
  }

  const existing = parsed.mcp_servers && parsed.mcp_servers[SERVER_KEY];
  const { expected } = await buildEntry();
  return {
    // If our entry is already in there, treat Codex as installed no matter what
    // detection thinks - never grey out a section that has live state in it.
    installed: installed || !!existing,
    exe,
    present: !!existing,
    inSync: entryMatches(existing, expected),
    path: p,
  };
}

// Self-heal a stale entry at startup, mirroring claudeConfig.healServerEntryIfStale.
// The `codexConfigWritten` marker is what stops us re-adding an entry the user
// deliberately deleted on a machine we never set up.
async function healServerEntryIfStale() {
  try {
    const raw = readRaw();
    const parsed = raw.trim() ? tomlEdit.parseOrNull(raw) : {};
    if (parsed === null) return { healed: false, reason: "config.toml is not valid TOML" };

    const existing = parsed.mcp_servers && parsed.mcp_servers[SERVER_KEY];

    if (!existing) {
      if (!credentials.readSettings().codexConfigWritten) {
        return { healed: false, reason: "no existing entry (never written by us)" };
      }
      const { clientId } = await credentials.getClientConfig();
      if (!clientId) return { healed: false, reason: "no existing entry (not configured)" };
      await writeServerEntry();
      return { healed: true, reason: "entry missing (restored)" };
    }

    const cmd = existing.command;
    const isBare = !cmd || !path.isAbsolute(cmd);
    const missing = cmd && path.isAbsolute(cmd) && !fs.existsSync(cmd);
    const { expected } = await buildEntry();
    const envStale = !entryMatches(existing, expected);
    if (!isBare && !missing && !envStale) return { healed: false, reason: "entry ok" };

    const good = await serverManager.resolveUvxPath();
    if (!good || !fs.existsSync(good)) return { healed: false, reason: "no valid uvx" };

    const staleKeys = existing.env
      ? CRITICAL_ENV.filter((k) => existing.env[k] !== expected.env[k])
      : CRITICAL_ENV;
    const reason = isBare ? "bare command" : missing ? "missing file" : `stale env: ${staleKeys.join(", ")}`;
    await writeServerEntry();
    log.info("codexConfig", "Healed stale Codex config", { was: cmd, now: good, reason });
    return { healed: true, was: cmd, now: good, reason };
  } catch (e) {
    log.error("codexConfig", "heal failed", { message: String(e) });
    return { healed: false, error: String(e) };
  }
}

module.exports = {
  getStatus,
  writeServerEntry,
  healServerEntryIfStale,
  configPath,
  buildEntry,
  SERVER_KEY,
  CODEX_MCP_PORT,
  SENTINELS,
};
