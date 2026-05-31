// Accounts service.
// Tracks which accounts the user wants connected, and derives live status by
// inspecting the token/credential files workspace-mcp caches in the shared dir.

const fs = require("fs");
const path = require("path");
const credentials = require("./credentials");

function registryPath() {
  // Co-locate a small registry next to the settings (list of emails the user added).
  const { app } = require("electron");
  return path.join(app.getPath("userData"), "accounts.json");
}

function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(registryPath(), "utf8"));
  } catch {
    return { emails: [] };
  }
}

function writeRegistry(reg) {
  fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2), { mode: 0o600 });
}

// Inspect the credentials dir for a cached token belonging to `email`.
// TODO(claude-code): confirm workspace-mcp's on-disk credential filename + JSON shape.
// It stores per-account credentials in GOOGLE_MCP_CREDENTIALS_DIR. Parse the token
// expiry to compute the countdown. Below is a best-effort reader to refine.
function readTokenStatus(email) {
  const dir = credentials.credentialsDir();
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return { connected: false };
  }

  // Heuristic: match a file that contains the email or its local-part.
  const local = email.split("@")[0];
  const match = files.find(
    (f) => f.includes(email) || f.includes(local)
  );
  if (!match) return { connected: false };

  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, match), "utf8"));
    // Common fields: expiry / expires_at / token_expiry (ISO or epoch).
    const expiryRaw = data.expiry || data.expires_at || data.token_expiry || null;
    const expiry = expiryRaw ? new Date(expiryRaw) : null;
    return {
      connected: true,
      expiry: expiry ? expiry.toISOString() : null,
      expired: expiry ? expiry.getTime() < Date.now() : false,
    };
  } catch {
    return { connected: true, expiry: null };
  }
}

function listAccounts() {
  const reg = readRegistry();
  return reg.emails.map((email) => ({ email, ...readTokenStatus(email) }));
}

function addAccount(email) {
  const reg = readRegistry();
  email = (email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return { ok: false, error: "Invalid email." };
  if (!reg.emails.includes(email)) reg.emails.push(email);
  writeRegistry(reg);
  return { ok: true };
}

function removeAccount(email) {
  const reg = readRegistry();
  reg.emails = reg.emails.filter((e) => e !== email);
  writeRegistry(reg);
  // NOTE: this only forgets the account in the UI. Per prohibited-action safety,
  // do NOT auto-delete the cached token file; leave that to the user.
  return { ok: true };
}

module.exports = { listAccounts, addAccount, removeAccount };
