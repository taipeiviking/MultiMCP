// Claude Desktop config service.
// Safely merges our `google_workspace` server entry into the user's
// claude_desktop_config.json without clobbering other servers. Backs up first.

const fs = require("fs");
const path = require("path");
const credentials = require("./credentials");
const serverManager = require("./serverManager");
const log = require("./logger");

const SERVER_KEY = "google_workspace";

function configPath() {
  // Windows: %APPDATA%\Claude\claude_desktop_config.json
  // (macOS path included for dev convenience.)
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA, "Claude", "claude_desktop_config.json");
  }
  return path.join(
    process.env.HOME,
    "Library",
    "Application Support",
    "Claude",
    "claude_desktop_config.json"
  );
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    return {};
  }
}

async function buildEntry() {
  const { clientId, credentialsDir } = await credentials.getClientConfig();
  const clientSecret = await credentials.getClientSecret();
  const uvxPath = await serverManager.resolveUvxPath(); // absolute path (Windows PATH safety)

  // SECURITY DECISION (SPEC §9): the stdio server Claude Desktop launches needs
  // GOOGLE_OAUTH_CLIENT_SECRET to refresh tokens for a confidential ("Web")
  // OAuth client. There is no way for that Python process to read Windows
  // Credential Manager, so for a Web client the secret must be injected into
  // this config file (readable by the current user). Setting
  // `injectSecretIntoConfig: false` omits it, but token refresh will then fail
  // for a Web client. Default: inject (and document the exposure).
  const settings = credentials.readSettings();
  const injectSecret = settings.injectSecretIntoConfig !== false;

  const env = {
    GOOGLE_OAUTH_CLIENT_ID: clientId,
    GOOGLE_MCP_CREDENTIALS_DIR: credentialsDir,
    OAUTHLIB_INSECURE_TRANSPORT: "1",
    // PIN the OAuth callback port. Without this, newer workspace-mcp versions pick
    // their own port when Claude launches the server (e.g. 8002 if 8000 is busy),
    // producing a redirect_uri that doesn't match the one registered on the OAuth
    // client -> "Error 400: redirect_uri_mismatch". The registered redirect URI is
    // http://localhost:8000/oauth2callback, so we force 8000 here too.
    WORKSPACE_MCP_PORT: String(serverManager.SIGNIN_PORT),
    WORKSPACE_MCP_BASE_URI: "http://localhost",
  };
  if (injectSecret) {
    env.GOOGLE_OAUTH_CLIENT_SECRET = clientSecret || "";
  }

  return {
    command: uvxPath || "uvx",
    args: ["workspace-mcp", "--tools", "gmail", "drive", "calendar"],
    env,
  };
}

async function getStatus() {
  const cfg = readConfig();
  const existing = cfg.mcpServers && cfg.mcpServers[SERVER_KEY];
  const desired = await buildEntry();
  const inSync =
    !!existing &&
    existing.command === desired.command &&
    JSON.stringify(existing.args) === JSON.stringify(desired.args) &&
    existing.env &&
    existing.env.GOOGLE_MCP_CREDENTIALS_DIR === desired.env.GOOGLE_MCP_CREDENTIALS_DIR &&
    existing.env.GOOGLE_OAUTH_CLIENT_ID === desired.env.GOOGLE_OAUTH_CLIENT_ID;
  return { present: !!existing, inSync, path: configPath() };
}

// Self-heal a stale config at startup. Rewrites the google_workspace entry when:
//   (a) command is bare "uvx" or an absolute path that no longer exists
//       -> Claude's "spawn uvx ENOENT"; OR
//   (b) the env is missing WORKSPACE_MCP_PORT -> newer workspace-mcp picks its own
//       callback port (e.g. 8002), causing "Error 400: redirect_uri_mismatch".
// So an existing install fixes itself on launch without a manual "Write config".
async function healServerEntryIfStale() {
  try {
    const cfg = readConfig();
    const existing = cfg.mcpServers && cfg.mcpServers[SERVER_KEY];
    if (!existing) return { healed: false, reason: "no existing entry" };

    const cmd = existing.command;
    const isBare = !cmd || !path.isAbsolute(cmd); // "uvx" (no path) can't be found by Claude
    const missing = cmd && path.isAbsolute(cmd) && !fs.existsSync(cmd);
    const wantPort = String(serverManager.SIGNIN_PORT);
    const portMissing = !existing.env || existing.env.WORKSPACE_MCP_PORT !== wantPort;

    if (!isBare && !missing && !portMissing) {
      return { healed: false, reason: "entry ok" };
    }

    // Need a valid uvx to write a usable entry (prefer bundled).
    const good = await serverManager.resolveUvxPath();
    if (!good || !fs.existsSync(good)) {
      log.warn("claudeConfig", "stale entry but no valid uvx to heal with", { cmd });
      return { healed: false, reason: "no valid uvx" };
    }

    const reason = isBare ? "bare command" : missing ? "missing file" : "missing port";
    await writeServerEntry();
    log.info("claudeConfig", "Healed stale Claude config", {
      was: cmd,
      now: good,
      portMissing,
      reason,
    });
    return { healed: true, was: cmd, now: good, reason };
  } catch (e) {
    log.error("claudeConfig", "heal failed", { message: String(e) });
    return { healed: false, error: String(e) };
  }
}

async function writeServerEntry() {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });

  // Back up before touching.
  let backup = null;
  if (fs.existsSync(p)) {
    backup = `${p}.bak-${Date.now()}`;
    fs.copyFileSync(p, backup);
  }

  const cfg = readConfig();
  cfg.mcpServers = cfg.mcpServers || {};
  const entry = await buildEntry();
  const existingServers = Object.keys(cfg.mcpServers);
  cfg.mcpServers[SERVER_KEY] = entry; // merge: only our key is replaced
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });

  log.info("claudeConfig", "Wrote Claude Desktop config", {
    path: p,
    backup,
    command: entry.command,
    args: entry.args,
    envKeys: Object.keys(entry.env),
    secretInjected: Object.prototype.hasOwnProperty.call(entry.env, "GOOGLE_OAUTH_CLIENT_SECRET"),
    preservedServers: existingServers.filter((k) => k !== SERVER_KEY),
  });

  return { ok: true, path: p, note: "Restart Claude Desktop to load changes." };
}

module.exports = {
  getStatus,
  writeServerEntry,
  healServerEntryIfStale,
  configPath,
  SERVER_KEY,
};
