// Credentials service.
// Client SECRET -> Windows Credential Manager (keytar). Never written to plaintext.
// Client ID + non-secret settings -> settings.json in userData.

const keytar = require("keytar");
const fs = require("fs");
const path = require("path");
const os = require("os");
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
  writeSettings(s);
  if (clientSecret) {
    await keytar.setPassword(SERVICE, SECRET_KEY, clientSecret.trim());
  }
  // TODO(claude-code): lock down ACLs on credentialsDir to current user only
  // (e.g. via `icacls` on Windows) the first time it's created.
  fs.mkdirSync(credentialsDir(), { recursive: true });
  return { ok: true };
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
