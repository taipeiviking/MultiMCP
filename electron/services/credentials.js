// Credentials service.
// Client SECRET -> Windows Credential Manager (keytar). Never written to plaintext.
// Client ID + non-secret settings -> settings.json in userData.

const keytar = require("keytar");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { app } = require("electron");

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

async function getClientConfig() {
  const s = readSettings();
  const hasSecret = (await keytar.getPassword(SERVICE, SECRET_KEY)) != null;
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
  }
  writeSettings(s);
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

module.exports = {
  getClientConfig,
  saveClientConfig,
  getClientSecret,
  credentialsDir,
  readSettings,
};
