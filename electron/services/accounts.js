// Accounts service.
// Tracks which accounts the user wants connected, and derives live status by
// inspecting the credential files workspace-mcp caches in the shared dir.
//
// Credential file format (confirmed against workspace-mcp 1.21.1
// auth/credential_store.py -> LocalDirectoryCredentialStore):
//   filename: <quote(email, safe="@._-")>.json   (plain "<email>.json" for
//             ordinary emails; e.g. "+" becomes "%2B"). A legacy scheme that
//             replaced non [A-Za-z0-9@._-] chars with "_" may also exist.
//   contents: { token, refresh_token, token_uri, client_id, client_secret,
//               scopes, expiry }
//   expiry:   ISO-8601 *timezone-naive UTC* (e.g. "2026-05-31T20:39:10.123456").
//             Must be treated as UTC, not local time.
//   "oauth_states.json" is internal state, not a user.

const fs = require("fs");
const path = require("path");
const credentials = require("./credentials");

const CRED_EXT = ".json";
const NON_CREDENTIAL_STEMS = new Set(["oauth_states"]);

function registryPath() {
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

// Mirror Python urllib.parse.quote(email, safe="@._-").
// urllib never quotes unreserved chars (A-Z a-z 0-9 _ . - ~); we add @._-.
function quoteEmail(email) {
  return Array.from(email)
    .map((ch) => {
      if (/[A-Za-z0-9_.\-~@]/.test(ch)) return ch;
      return Array.from(Buffer.from(ch, "utf8"))
        .map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0"))
        .join("");
    })
    .join("");
}

// Pre-URL-encoding legacy filename form (older workspace-mcp versions).
function legacySafeEmail(email) {
  return email.replace(/[^a-zA-Z0-9@._-]/g, "_");
}

function decodeStem(stem) {
  if (stem.includes("%")) {
    try {
      return decodeURIComponent(stem);
    } catch {
      return stem;
    }
  }
  return stem;
}

// Resolve the on-disk credential path for an email. Returns the existing file if
// found (URL-encoded form preferred, then a directory scan by decoded name, then
// the legacy underscore form); otherwise returns the expected URL-encoded path
// (which may not exist yet — callers should handle ENOENT).
function credentialFilePath(email) {
  const dir = credentials.credentialsDir();
  const target = (email || "").trim().toLowerCase();
  if (!target) return null;

  const expected = path.join(dir, quoteEmail(target) + CRED_EXT);
  if (safeExists(expected)) return expected;

  // Scan the directory and match by decoded stem (mirrors store.list_users()).
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return expected;
  }
  for (const f of files) {
    if (!f.endsWith(CRED_EXT)) continue;
    const stem = f.slice(0, -CRED_EXT.length);
    if (NON_CREDENTIAL_STEMS.has(stem)) continue;
    if (decodeStem(stem).toLowerCase() === target) {
      return path.join(dir, f);
    }
  }

  const legacy = path.join(dir, legacySafeEmail(target) + CRED_EXT);
  if (safeExists(legacy)) return legacy;

  return expected;
}

function safeExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

// Parse a workspace-mcp expiry string (timezone-naive UTC) to a Date.
function parseExpiry(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  // If no timezone designator is present, the value is naive UTC — mark it so.
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) s += "Z";
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function readTokenStatus(email) {
  const p = credentialFilePath(email);
  if (!p || !safeExists(p)) return { connected: false };

  let data;
  try {
    data = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return { connected: true, expiry: null };
  }

  const expiry = parseExpiry(data.expiry);
  const hasRefresh = !!data.refresh_token;
  return {
    connected: true,
    hasRefresh,
    scopes: Array.isArray(data.scopes) ? data.scopes : [],
    expiry: expiry ? expiry.toISOString() : null,
    expired: expiry ? expiry.getTime() < Date.now() : false,
  };
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
  // NOTE: this only forgets the account in the UI. We do NOT auto-delete the
  // cached token file; that's the user's call.
  return { ok: true };
}

module.exports = {
  listAccounts,
  addAccount,
  removeAccount,
  readTokenStatus,
  credentialFilePath,
};
