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

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(obj) {
  fs.writeFileSync(settingsPath(), JSON.stringify(obj, null, 2), { mode: 0o600 });
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

async function getClientConfig() {
  const s = readSettings();
  const hasSecret = (await getSecretResilient()) != null;
  return {
    clientId: s.clientId || "",
    hasSecret,
    credentialsDir: credentialsDir(),
  };
}

async function saveClientConfig(clientId, clientSecret) {
  const s = readSettings();
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
function patchSettings(partial) {
  const s = readSettings();
  Object.assign(s, partial || {});
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
