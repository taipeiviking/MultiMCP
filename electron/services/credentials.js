// Credentials service.
// Client SECRET -> Windows Credential Manager (keytar). Never written to plaintext.
// Client ID + non-secret settings -> settings.json in userData.

const keytar = require("keytar");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { app } = require("electron");
const log = require("./logger");

const SERVICE = "google-workspace-manager";
const SECRET_KEY = "oauth_client_secret";

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function backupPath() {
  return `${settingsPath()}.bak`;
}

function parseSettings(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// Load settings, distinguishing states that MUST NOT be conflated:
//   "missing"     - no file: a genuinely fresh install, {} is the right answer.
//   "ok"          - parsed fine.
//   "recovered"   - the file was empty/unparseable but settings.json.bak was good.
//   "quarantined" - corrupt with no usable backup. The data is genuinely gone, so
//                   we set the ruined file aside and start clean - otherwise the
//                   app could never save anything again.
//   "unusable"    - the file could not be READ (locked / AV / permissions). We do
//                   not know what is in it, so data is null and callers MUST NOT
//                   write over it.
//
// The old code collapsed all of these into `return {}`. Combined with a
// read-modify-write patchSettings(), that turned a single transient read failure
// (or a truncated file after an unclean shutdown) into permanent data loss: the
// next window-move wrote `{windowBounds}` over a config that still had the
// clientId in it. That is exactly how a PC restart wiped this user's setup twice.
function loadSettings() {
  const p = settingsPath();
  let text;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { data: {}, state: "missing" };
    log.error("credentials", "settings unreadable (will not overwrite)", {
      code: e.code,
      message: String(e),
    });
    return { data: null, state: "unusable" };
  }

  const parsed = parseSettings(text);
  if (parsed) return { data: parsed, state: "ok" };

  // The file exists but is empty or malformed - a truncated write. Recover.
  let backup = null;
  try {
    backup = parseSettings(fs.readFileSync(backupPath(), "utf8"));
  } catch {
    /* no usable backup */
  }
  if (backup) {
    log.warn("credentials", "settings.json corrupt - recovered from backup", {
      corruptBytes: text.length,
      keys: Object.keys(backup),
    });
    writeSettings(backup); // restore the primary immediately
    return { data: backup, state: "recovered" };
  }

  // Corrupt with nothing to recover from. Keep the ruined bytes for forensics, but
  // get it out of the way so the app can be reconfigured (the UI will offer Import).
  const quarantine = `${p}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(p, quarantine);
    log.error("credentials", "settings.json corrupt and no usable backup - quarantined", {
      corruptBytes: text.length,
      quarantine,
    });
  } catch (e) {
    log.error("credentials", "settings.json corrupt; quarantine failed", {
      message: String(e),
    });
    return { data: null, state: "unusable" };
  }
  return { data: {}, state: "quarantined" };
}

function readSettings() {
  return loadSettings().data || {};
}

// Atomic write: a plain writeFileSync truncates the file in place, so an unclean
// shutdown mid-write leaves a zero-length settings.json. Write a temp file, flush
// it to disk, then rename over the primary (rename is atomic on NTFS). Keep the
// previous good copy in settings.json.bak so corruption is always recoverable.
function writeSettings(obj) {
  const p = settingsPath();
  const tmp = `${p}.tmp`;
  fs.mkdirSync(path.dirname(p), { recursive: true });

  try {
    if (fs.existsSync(p) && parseSettings(fs.readFileSync(p, "utf8"))) {
      fs.copyFileSync(p, backupPath());
    }
  } catch (e) {
    log.warn("credentials", "could not refresh settings backup", { message: String(e) });
  }

  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(obj, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
}

// Fixed, shared credentials dir used by BOTH our transient sign-in server and the
// stdio server Claude Desktop launches. This is the linchpin of the whole design.
function credentialsDir() {
  const s = readSettings();
  return (
    s.credentialsDir ||
    path.join(os.homedir(), ".google_workspace_mcp", "credentials")
  );
}

// Read the secret from Credential Manager, tolerating a TRANSIENT failure right at
// boot. When the app autostarts hidden immediately after login (esp. after a Fast
// Startup resume), keytar/Credential Manager can briefly throw or return null before
// the vault is ready — which made the UI wrongly show the first-run setup screen
// even though a secret was stored. Retry a few times with a short backoff.
async function getSecretResilient() {
  const RETRIES = 5;
  for (let i = 0; i < RETRIES; i++) {
    try {
      const v = await keytar.getPassword(SERVICE, SECRET_KEY);
      if (v != null) return v;
    } catch (e) {
      log.warn("credentials", "keytar read failed (retrying)", {
        attempt: i + 1,
        message: String(e),
      });
    }
    // Only keep retrying if settings say a secret SHOULD exist (avoids a pointless
    // ~1s delay on a genuinely fresh, unconfigured machine).
    if (!readSettings().clientId) break;
    await new Promise((r) => setTimeout(r, 200 * (i + 1))); // 200,400,600,800ms
  }
  return null;
}

// Number of per-account token files already on disk. Used to tell a genuinely
// fresh machine apart from one whose settings.json was lost: tokens (and a stored
// secret) without a clientId means "your config went missing", not "welcome".
function countTokenFiles() {
  try {
    return fs
      .readdirSync(credentialsDir())
      .filter((f) => f.endsWith(".json") && f !== "oauth_states.json").length;
  } catch {
    return 0;
  }
}

async function getClientConfig() {
  const { data, state } = loadSettings();
  const s = data || {};
  const hasSecret = (await getSecretResilient()) != null;
  const clientId = s.clientId || "";
  const tokenCount = countTokenFiles();
  return {
    clientId,
    hasSecret,
    credentialsDir: credentialsDir(),
    settingsState: state,
    tokenCount,
    // The renderer shows a recovery prompt instead of the first-run screen when
    // this is true (previous setup detected, but the clientId is gone).
    needsRecovery: !clientId && (hasSecret || tokenCount > 0),
  };
}

async function saveClientConfig(clientId, clientSecret) {
  const { data, state } = loadSettings();
  if (data === null) {
    // Don't half-save into a config we can't read - the user would end up with a
    // clientId and nothing else. Surface it instead.
    throw new Error(
      `Settings file is unreadable (${state}). Not saving, to avoid losing your existing configuration.`
    );
  }
  const s = data;
  s.clientId = (clientId || "").trim();
  if (!s.credentialsDir) s.credentialsDir = credentialsDir();
  if (clientSecret) {
    await keytar.setPassword(SERVICE, SECRET_KEY, clientSecret.trim());
  }
  const dir = credentialsDir();
  fs.mkdirSync(dir, { recursive: true });
  // Lock the credentials dir down to the current user the first time we create it.
  // Token files are secrets; restrict ACLs so other local users can't read them.
  if (!s.aclLocked) {
    const locked = await lockdownDir(dir);
    if (locked) {
      s.aclLocked = true;
    }
    log.info("credentials", "ACL lockdown attempt", { dir, locked });
  }
  writeSettings(s);
  log.info("credentials", "Saved client config", {
    clientIdTail: s.clientId ? s.clientId.slice(-28) : null,
    secretUpdated: !!clientSecret,
    credentialsDir: dir,
    aclLocked: !!s.aclLocked,
  });
  return { ok: true };
}

// Restrict a directory to the current user only (Windows: icacls). Best-effort:
// returns true on success, false otherwise (we retry next save if it fails).
function lockdownDir(dir) {
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(dir, 0o700);
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  }
  const user = process.env.USERNAME
    ? `${process.env.USERDOMAIN || os.hostname()}\\${process.env.USERNAME}`
    : null;
  if (!user) return Promise.resolve(false);
  return new Promise((resolve) => {
    // /inheritance:r removes inherited ACEs; grant only this user full control.
    execFile(
      "icacls",
      [dir, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`, "/T", "/C"],
      (err) => resolve(!err)
    );
  });
}

async function getClientSecret() {
  return keytar.getPassword(SERVICE, SECRET_KEY);
}

// Merge a partial object into settings.json and persist (for non-secret prefs
// like the autostart choice). Returns the updated settings.
//
// If the existing settings could not be read, this does NOT write. Merging into
// the {} we would otherwise have fallen back to would silently erase the real
// config (clientId, credentialsDir, autostart) on the next window move.
function patchSettings(partial) {
  const { data, state } = loadSettings();
  if (data === null) {
    log.error("credentials", "refusing to patch settings over an unreadable file", {
      state,
      wouldHaveSet: Object.keys(partial || {}),
    });
    return {};
  }
  const s = Object.assign({}, data, partial || {});
  writeSettings(s);
  return s;
}

module.exports = {
  getClientConfig,
  saveClientConfig,
  getClientSecret,
  credentialsDir,
  readSettings,
  patchSettings,
};
