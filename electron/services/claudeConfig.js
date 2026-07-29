// Claude Desktop config service.
// Safely merges our `google_workspace` server entry into the user's
// claude_desktop_config.json without clobbering other servers. Backs up first.

const fs = require("fs");
const path = require("path");
const credentials = require("./credentials");
const serverManager = require("./serverManager");
const noBrowser = require("./noBrowser");
const signal = require("./signal");
const log = require("./logger");

// The key in claude_desktop_config.json IS the connector name Claude shows in its
// UI. It used to be "google_workspace", which didn't match the tray app's name and
// left people unsure the two were the same thing. Renamed to match the app.
const SERVER_KEY = "MultiMCP";

// Second managed entry: the Signal messenger connector (present only while a
// Signal account is linked in the app). A separate server entry — NOT more tools
// on the Google one — because it is a different server process with a different
// lifecycle; sharing a key would couple their staleness and their restarts.
const SIGNAL_SERVER_KEY = "MultiMCP-Signal";

// Older names we must clean up when we (re)write the entry - otherwise Claude would
// list the connector twice, and the stale one would still spawn a second server.
const LEGACY_SERVER_KEYS = ["google_workspace"];

function findLegacyKey(cfg) {
  const servers = cfg.mcpServers || {};
  return LEGACY_SERVER_KEYS.find((k) => servers[k]) || null;
}

// Claude's BACKGROUND server gets its OWN port, separate from the tray app's
// interactive sign-in port (serverManager.SIGNIN_PORT = 8000). Why: both the tray
// app's sign-in and Claude's persistent server start a "minimal OAuth server" on a
// port. If both want 8000, whichever starts second falls back to 8002 — and an
// interactive sign-in on 8002 fails with redirect_uri_mismatch (only :8000 is
// registered). By pinning Claude's server to 9000, port 8000 stays FREE for the
// tray app's sign-in, so the consent redirect always uses the registered :8000.
//
// :9000 is deliberately NOT a registered redirect URI, and must stay that way. It
// is a safety interlock: if the background server ever does start an OAuth flow, we
// want that flow to be incapable of completing. A background process silently
// obtaining consent - and, with prompt=select_account, possibly for the WRONG
// account, overwriting a token file - is worse than a visible failure.
const CLAUDE_MCP_PORT = 9000;

// Env keys that must match for an existing entry to count as up to date. Anything
// here is load-bearing; if we add a key and don't list it, existing installs keep
// the old entry forever (healServerEntryIfStale would say "entry ok").
const CRITICAL_ENV = [
  "MCP_SINGLE_USER_MODE",
  "BROWSER",
  "WORKSPACE_MCP_PORT",
  "GOOGLE_MCP_CREDENTIALS_DIR",
  "GOOGLE_OAUTH_CLIENT_ID",
];

function entryMatches(existing, desired, critical = CRITICAL_ENV) {
  if (!existing || !existing.env) return false;
  if (existing.command !== desired.command) return false;
  if (JSON.stringify(existing.args) !== JSON.stringify(desired.args)) return false;
  return critical.every((k) => existing.env[k] === desired.env[k]);
}

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

// Same file, but for the WRITE path, where "I couldn't read it" and "it isn't there"
// must not be confused. writeServerEntry merges into whatever it reads and writes the
// result back, so treating a locked or permission-denied file as an empty config would
// silently drop every other MCP server the user has. Missing -> "", anything else throws.
function readRawForWrite() {
  try {
    return fs.readFileSync(configPath(), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return "";
    throw e;
  }
}

// Prove the bytes that actually LANDED on disk are good - not just the string we meant
// to write. Catches a truncated write, an encoding mangle, or an AV product rewriting
// the file behind us. Anything returned here triggers a rollback to the backup.
function verifyOnDisk(p, desired, preservedServers) {
  let onDisk;
  try {
    onDisk = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return [`it does not re-read as valid JSON (${e.message})`];
  }
  const problems = [];
  const servers = (onDisk && onDisk.mcpServers) || {};
  for (const [key, entry] of Object.entries(desired)) {
    if (JSON.stringify(servers[key]) !== JSON.stringify(entry)) {
      problems.push(`the "${key}" entry is missing or is not what we wrote`);
    }
  }
  // A managed key we did NOT want this time (e.g. MultiMCP-Signal after an
  // unlink) must actually be gone.
  for (const k of MANAGED_KEYS) {
    if (!(k in desired) && servers[k]) problems.push(`the "${k}" entry should have been removed`);
  }
  for (const k of LEGACY_SERVER_KEYS) {
    if (servers[k]) problems.push(`the legacy "${k}" entry is still present`);
  }
  const lost = preservedServers.filter((k) => !servers[k]);
  if (lost.length) problems.push(`other MCP servers were lost: ${lost.join(", ")}`);
  return problems;
}

// Every key this app owns in the user's config. Anything else in mcpServers is
// the user's and must never be touched.
const MANAGED_KEYS = [SERVER_KEY, SIGNAL_SERVER_KEY];

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
    // Newer workspace-mcp prefers WORKSPACE_MCP_CREDENTIALS_DIR and checks it FIRST
    // (credential_store.py:88-106). Set both, so a stray machine-level value can't
    // silently win and point the server at an empty dir - which would make every
    // account look unauthenticated, i.e. this same bug by another route.
    WORKSPACE_MCP_CREDENTIALS_DIR: credentialsDir,
    OAUTHLIB_INSECURE_TRANSPORT: "1",
    // Pin Claude's background server to its OWN port (not the tray app's 8000), so
    // the two never contend for 8000. See CLAUDE_MCP_PORT note above.
    WORKSPACE_MCP_PORT: String(CLAUDE_MCP_PORT),
    // Bare PORT is read BEFORE WORKSPACE_MCP_PORT (core/config.py:38,
    // port_resolver.py:87-88). A machine-level PORT=8000 would collapse the
    // 8000/9000 split and steal the tray app's registered sign-in port.
    PORT: String(CLAUDE_MCP_PORT),
    WORKSPACE_MCP_BASE_URI: "http://localhost",

    // THE FIX for the spurious OAuth tabs.
    //
    // workspace-mcp binds the MCP session to the FIRST account that refreshes a
    // token, and that binding is immutable (oauth21_session_store.py:653-665). For
    // every LATER distinct account, the token refreshes fine and is written to disk,
    // and then store_session() raises ValueError("Session ... is already bound to a
    // different user"). That ValueError is swallowed by the broad `except Exception`
    // around the refresh (google_auth.py:1167-1172) and returned as None, so the
    // caller concludes "not authenticated" and calls start_auth_flow() ->
    // webbrowser.open(). One unwanted tab per account, on every session where the
    // tokens are older than an hour - i.e. every real multi-account session, which
    // is the entire point of this app.
    //
    // "Single user" is a misnomer: it does NOT limit us to one account. It bypasses
    // the session->user mapping and looks credentials up by the email the tool was
    // called with (google_auth.py:1003-1022), which is exactly what we want. Leave
    // USER_GOOGLE_EMAIL unset - setting it would make user_google_email optional and
    // let a tool call silently default to the wrong account.
    //
    // Set via env, not the --single-user CLI flag: an unknown env var is inert, but
    // an argparse flag that upstream renames is a hard exit(1) and the connector dies.
    MCP_SINGLE_USER_MODE: "1",
  };
  if (injectSecret) {
    env.GOOGLE_OAUTH_CLIENT_SECRET = clientSecret || "";
  }

  // Belt and braces: even with the above, a genuinely revoked token still reaches
  // start_auth_flow(). Point BROWSER at a shim so the background server physically
  // cannot open a tab. Only set it if the shim really exists on disk - a BROWSER
  // pointing at a missing file (or an empty string) FAILS OPEN, i.e. the real
  // browser opens after all. See noBrowser.js.
  const shim = noBrowser.shimPathIfPresent();
  if (shim) env.BROWSER = shim;

  return {
    command: uvxPath || "uvx",
    args: ["workspace-mcp", "--tools", "gmail", "drive", "calendar"],
    env,
  };
}

// All entries this app wants in the config RIGHT NOW, with the env keys whose
// drift makes each stale. The Signal entry appears only while an account is
// linked (and the engine is bundled); when it should not exist, write/heal
// REMOVE it — a connector Claude lists must actually work.
async function desiredEntries() {
  const entries = [
    { key: SERVER_KEY, entry: await buildEntry(), critical: CRITICAL_ENV },
  ];
  const sig = await signal.buildEntryParts();
  if (sig) entries.push({ key: SIGNAL_SERVER_KEY, entry: sig, critical: signal.CRITICAL_ENV });
  return entries;
}

// Are all managed entries present+current, and no managed key present that
// shouldn't be? Factored out because getStatus and healServerEntryIfStale must
// agree on the answer — "in sync" in the UI and "entry ok" in the healer are
// the same judgement.
function entriesInSync(servers, desired) {
  for (const { key, entry, critical } of desired) {
    if (!entryMatches(servers[key], entry, critical)) return false;
  }
  for (const k of MANAGED_KEYS) {
    if (!desired.some((d) => d.key === k) && servers[k]) return false;
  }
  return true;
}

async function getStatus() {
  const cfg = readConfig();
  const servers = cfg.mcpServers || {};
  const existing = servers[SERVER_KEY];
  const legacyKey = findLegacyKey(cfg);
  const desired = await desiredEntries();
  // A leftover google_workspace entry means "not in sync" even if ours looks right:
  // Claude would spawn BOTH servers, and the old one still opens OAuth tabs.
  const inSync = !legacyKey && entriesInSync(servers, desired);
  return {
    present: !!existing,
    inSync,
    legacyKey,
    path: configPath(),
    signalPresent: !!servers[SIGNAL_SERVER_KEY],
    signalDesired: desired.some((d) => d.key === SIGNAL_SERVER_KEY),
  };
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

    // Entry gone entirely. This is not necessarily a fresh machine: reinstalling
    // Claude Desktop replaces claude_desktop_config.json, silently dropping the
    // connector. If we wrote the entry before and are still configured, put it
    // back. The `claudeConfigWritten` marker is what keeps this from re-adding an
    // entry the user deliberately removed on a machine we never set up.
    // An entry under the OLD name is ours: migrate it to the new one (writeServerEntry
    // deletes the legacy key). Do this before the "missing entry" branch, or the
    // rename would look like a fresh install and leave both keys behind.
    const legacyKey = findLegacyKey(cfg);
    if (!existing && legacyKey) {
      const { clientId } = await credentials.getClientConfig();
      if (!clientId) return { healed: false, reason: `legacy "${legacyKey}" entry but not configured` };
      await writeServerEntry();
      log.info("claudeConfig", "Renamed connector", { from: legacyKey, to: SERVER_KEY });
      return { healed: true, reason: `renamed "${legacyKey}" -> "${SERVER_KEY}"` };
    }

    if (!existing) {
      const settings = credentials.readSettings();
      if (!settings.claudeConfigWritten) {
        return { healed: false, reason: "no existing entry (never written by us)" };
      }
      const { clientId } = await credentials.getClientConfig();
      if (!clientId) return { healed: false, reason: "no existing entry (not configured)" };
      await writeServerEntry();
      log.info("claudeConfig", `Re-added missing ${SERVER_KEY} entry`, { path: configPath() });
      return { healed: true, reason: "entry missing (restored)" };
    }

    // Our entry exists but a stale legacy one is still alongside it - drop the old one.
    if (legacyKey) {
      await writeServerEntry();
      log.info("claudeConfig", "Removed leftover legacy connector", { legacyKey });
      return { healed: true, reason: `removed leftover "${legacyKey}"` };
    }

    const cmd = existing.command;
    const isBare = !cmd || !path.isAbsolute(cmd); // "uvx" (no path) can't be found by Claude
    const missing = cmd && path.isAbsolute(cmd) && !fs.existsSync(cmd);
    // Any drift in a load-bearing env key (CRITICAL_ENV) is stale. This is what
    // delivers a new setting - e.g. MCP_SINGLE_USER_MODE, the fix for the spurious
    // OAuth tabs - to machines that already have an entry. Comparing only the port
    // (as we used to) would report "entry ok" forever and they'd never get it.
    // Since v0.9.0 this judgement covers ALL managed entries (Google + Signal), so
    // linking/unlinking Signal is delivered by the same heal path.
    const desired = await desiredEntries();
    const envStale = !entriesInSync(cfg.mcpServers || {}, desired);

    if (!isBare && !missing && !envStale) {
      return { healed: false, reason: "entry ok" };
    }

    // Need a valid uvx to write a usable entry (prefer bundled).
    const good = await serverManager.resolveUvxPath();
    if (!good || !fs.existsSync(good)) {
      log.warn("claudeConfig", "stale entry but no valid uvx to heal with", { cmd });
      return { healed: false, reason: "no valid uvx" };
    }

    const googleDesired = desired[0].entry;
    const staleKeys = existing.env
      ? CRITICAL_ENV.filter((k) => existing.env[k] !== googleDesired.env[k])
      : CRITICAL_ENV;
    const reason = isBare
      ? "bare command"
      : missing
        ? "missing file"
        : staleKeys.length
          ? `stale env: ${staleKeys.join(", ")}`
          : "signal entry drift";
    await writeServerEntry();
    log.info("claudeConfig", "Healed stale Claude config", {
      was: cmd,
      now: good,
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
  const raw = readRawForWrite(); // throws (rather than returning "") if the file is unreadable

  // A file that exists but does not parse is already broken for Claude, and there is
  // no server list left in it to preserve - so rewriting it is the repair, not the
  // damage. But say so loudly: corrupt bytes here are exactly what the old truncating
  // write left behind on an unclean shutdown, and the backup below keeps them.
  let cfg = {};
  if (raw.trim()) {
    try {
      cfg = JSON.parse(raw);
    } catch (e) {
      cfg = null;
    }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
      log.warn("claudeConfig", "claude_desktop_config.json is not a valid JSON object - rewriting it", {
        path: p,
        bytes: raw.length,
      });
      cfg = {};
    }
  }

  cfg.mcpServers = cfg.mcpServers || {};
  const desired = await desiredEntries();
  const desiredMap = Object.fromEntries(desired.map((d) => [d.key, d.entry]));

  // Drop any entry we used to write under an older name. Without this the rename
  // leaves BOTH keys behind: Claude lists two connectors and spawns two servers,
  // and the stale one keeps the old env - so it keeps opening OAuth tabs.
  const removed = LEGACY_SERVER_KEYS.filter((k) => cfg.mcpServers[k]);
  for (const k of removed) delete cfg.mcpServers[k];

  // Managed keys that should no longer exist (a Signal entry after an unlink)
  // go the same way — a listed connector that cannot work is worse than none.
  for (const k of MANAGED_KEYS) {
    if (!(k in desiredMap) && cfg.mcpServers[k]) {
      delete cfg.mcpServers[k];
      removed.push(k);
    }
  }

  Object.assign(cfg.mcpServers, desiredMap); // merge: only our keys are replaced
  const preserved = Object.keys(cfg.mcpServers).filter((k) => !(k in desiredMap));

  // Back up before touching.
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let backup = null;
  if (fs.existsSync(p)) {
    backup = `${p}.bak-${Date.now()}`;
    fs.copyFileSync(p, backup);
  }

  // Atomic write (credentials.js writeSettings convention, mirrored in codexConfig.js):
  // a plain writeFileSync TRUNCATES the target in place, so a crash, power loss or
  // unclean shutdown mid-write leaves a zero-length or half-written config - destroying
  // our entry AND every other MCP server the user had. That is the same failure mode
  // v0.3.9 fixed for settings.json, and this file had it too. Write a temp file, flush
  // it to disk, then rename over the primary (rename is atomic on NTFS).
  const tmp = `${p}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(cfg, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);

  // Re-read from DISK and check what landed. Only here can a rollback be needed, and
  // leaving the user's file worse than we found it is the one outcome we will not have.
  const problems = verifyOnDisk(p, desiredMap, preserved);
  if (problems.length) {
    if (backup) fs.copyFileSync(backup, p);
    else fs.unlinkSync(p); // we created it; leave the machine as we found it
    log.error("claudeConfig", "post-write validation failed - rolled back", {
      path: p,
      backup,
      problems,
    });
    throw new Error(
      `Wrote ${p} but it did not verify; restored the previous file. ${problems.join("; ")}`
    );
  }

  // Remember that this machine's Claude config is ours to maintain, so that a
  // later Claude reinstall (which wipes the file) can be healed automatically.
  credentials.patchSettings({ claudeConfigWritten: true });

  const googleEntry = desiredMap[SERVER_KEY];
  log.info("claudeConfig", "Wrote Claude Desktop config", {
    path: p,
    backup,
    keys: Object.keys(desiredMap),
    removedKeys: removed,
    command: googleEntry.command,
    args: googleEntry.args,
    envKeys: Object.keys(googleEntry.env),
    secretInjected: Object.prototype.hasOwnProperty.call(googleEntry.env, "GOOGLE_OAUTH_CLIENT_SECRET"),
    browserSuppressed: !!googleEntry.env.BROWSER,
    signalEntry: SIGNAL_SERVER_KEY in desiredMap,
    preservedServers: preserved,
  });

  return { ok: true, path: p, note: "Restart Claude Desktop to load changes." };
}

module.exports = {
  getStatus,
  writeServerEntry,
  healServerEntryIfStale,
  configPath,
  SERVER_KEY,
  SIGNAL_SERVER_KEY,
};
