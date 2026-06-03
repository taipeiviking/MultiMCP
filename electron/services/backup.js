// Export / import the full app state as a single portable JSON file, so the same
// multi-account setup can be moved to another computer.
//
// A complete backup contains FOUR things — all required for the target machine to
// "just work" without re-running Google OAuth:
//   1. settings        — settings.json (Client ID, credentialsDir, prefs)
//   2. clientSecret     — the OAuth client secret (from Windows Credential Manager)
//   3. accounts         — accounts.json (email list + authorizedAt timestamps)
//   4. credentialFiles  — the per-email token files (refresh tokens) that grant
//                         workspace-mcp access. Keyed by email; written back with
//                         the exact filename workspace-mcp expects on import.
//
// The file is SENSITIVE (it carries refresh tokens + the client secret). The UI
// warns the user; we also mark it 0600 on write.

const fs = require("fs");
const path = require("path");
const keytar = require("keytar");
const credentials = require("./credentials");
const { quoteEmail } = require("./emailName");
const log = require("./logger");

const SERVICE = "google-workspace-manager";
const SECRET_KEY = "oauth_client_secret";
const FORMAT = "gwm-backup";
const FORMAT_VERSION = 1;

function appVersion() {
  try {
    return require("electron").app.getVersion();
  } catch {
    return null;
  }
}

function readJsonSafe(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

// Collect the per-email credential token files from the shared credentials dir.
// Returns { "<email>": <parsed JSON token object>, ... }. We read every *.json in
// the dir except internal state, keyed by the decoded email stem.
function collectCredentialFiles() {
  const dir = credentials.credentialsDir();
  const out = {};
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const stem = f.slice(0, -".json".length);
    if (stem === "oauth_states") continue; // internal, not a user
    let email = stem;
    if (stem.includes("%")) {
      try {
        email = decodeURIComponent(stem);
      } catch {
        /* keep raw stem */
      }
    }
    const data = readJsonSafe(path.join(dir, f), null);
    if (data) out[email.toLowerCase()] = data;
  }
  return out;
}

// Build the full backup object.
async function buildBackup() {
  const settings = credentials.readSettings();
  const accountsReg = readJsonSafe(
    path.join(require("electron").app.getPath("userData"), "accounts.json"),
    { emails: [] }
  );
  let clientSecret = null;
  try {
    clientSecret = await keytar.getPassword(SERVICE, SECRET_KEY);
  } catch (e) {
    log.warn("backup", "could not read client secret", { message: String(e) });
  }
  const credentialFiles = collectCredentialFiles();

  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    appVersion: appVersion(),
    exportedAt: new Date().toISOString(),
    settings,
    clientSecret: clientSecret || null,
    accounts: accountsReg,
    credentialFiles,
    counts: {
      accounts: (accountsReg.emails || []).length,
      credentialFiles: Object.keys(credentialFiles).length,
      hasSecret: !!clientSecret,
    },
  };
}

// Write the backup JSON to an absolute path. 0600 so other local users can't read
// the refresh tokens inside.
async function exportToFile(filePath) {
  const backup = await buildBackup();
  fs.writeFileSync(filePath, JSON.stringify(backup, null, 2), { mode: 0o600 });
  log.info("backup", "exported", { filePath, counts: backup.counts });
  return { ok: true, path: filePath, counts: backup.counts };
}

// Validate a parsed object is one of our backups.
function validate(obj) {
  if (!obj || typeof obj !== "object") return "Not a valid backup file.";
  if (obj.format !== FORMAT) return "Unrecognized file (missing gwm-backup marker).";
  if (typeof obj.formatVersion !== "number") return "Missing format version.";
  if (obj.formatVersion > FORMAT_VERSION) {
    return `Backup is from a newer app version (format ${obj.formatVersion}). Update this app first.`;
  }
  return null;
}

// Import a backup object into this machine. Non-destructive merge by default:
//   - settings: imported settings win for clientId/prefs, but we keep THIS
//     machine's credentialsDir unless the import explicitly carries one AND the
//     local one is unset (paths differ per machine/user).
//   - clientSecret: restored to Credential Manager if present.
//   - accounts: union of email lists; authorizedAt timestamps merged.
//   - credentialFiles: written into the local credentials dir with the correct
//     per-email filename (skips ones already present unless overwrite=true).
async function importBackup(obj, opts = {}) {
  const overwrite = !!opts.overwrite;
  const err = validate(obj);
  if (err) return { ok: false, error: err };

  const result = {
    ok: true,
    settingsUpdated: false,
    secretRestored: false,
    accountsAdded: 0,
    credentialFilesWritten: 0,
    credentialFilesSkipped: 0,
  };

  // 1) settings — preserve THIS machine's credentialsDir (machine-specific path).
  const local = credentials.readSettings();
  const incoming = obj.settings && typeof obj.settings === "object" ? obj.settings : {};
  const merged = { ...local, ...incoming };
  // Always keep the local credentials dir if we already have one; otherwise fall
  // back to the imported one, else the default is derived later by credentialsDir().
  if (local.credentialsDir) merged.credentialsDir = local.credentialsDir;
  // The ACL-locked flag is machine-specific; don't carry a foreign "true" over.
  if (!local.credentialsDir) delete merged.aclLocked;
  credentials.patchSettings(merged);
  result.settingsUpdated = true;

  // 2) client secret
  if (obj.clientSecret) {
    try {
      await keytar.setPassword(SERVICE, SECRET_KEY, obj.clientSecret);
      result.secretRestored = true;
    } catch (e) {
      log.error("backup", "secret restore failed", { message: String(e) });
    }
  }

  // 3) accounts registry (union)
  const regPath = path.join(
    require("electron").app.getPath("userData"),
    "accounts.json"
  );
  const localReg = readJsonSafe(regPath, { emails: [] });
  const inReg = obj.accounts && typeof obj.accounts === "object" ? obj.accounts : { emails: [] };
  const emailSet = new Set((localReg.emails || []).map((e) => e.toLowerCase()));
  const before = emailSet.size;
  for (const e of inReg.emails || []) emailSet.add(String(e).toLowerCase());
  const mergedAuthorizedAt = { ...(localReg.authorizedAt || {}), ...(inReg.authorizedAt || {}) };
  const mergedReg = { ...localReg, emails: Array.from(emailSet), authorizedAt: mergedAuthorizedAt };
  fs.writeFileSync(regPath, JSON.stringify(mergedReg, null, 2), { mode: 0o600 });
  result.accountsAdded = emailSet.size - before;

  // 4) credential token files
  const dir = credentials.credentialsDir();
  fs.mkdirSync(dir, { recursive: true });
  const files = obj.credentialFiles && typeof obj.credentialFiles === "object" ? obj.credentialFiles : {};
  for (const [email, data] of Object.entries(files)) {
    const target = path.join(dir, quoteEmail(email.toLowerCase()) + ".json");
    if (fs.existsSync(target) && !overwrite) {
      result.credentialFilesSkipped++;
      continue;
    }
    try {
      fs.writeFileSync(target, JSON.stringify(data, null, 2), { mode: 0o600 });
      result.credentialFilesWritten++;
    } catch (e) {
      log.error("backup", "cred write failed", { email, message: String(e) });
    }
  }

  log.info("backup", "imported", { ...result, overwrite });
  return result;
}

async function importFromFile(filePath, opts) {
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    return { ok: false, error: "Could not read/parse file: " + String(e) };
  }
  return importBackup(obj, opts);
}

// Peek at a backup file without importing (for the confirm dialog).
function inspectFile(filePath) {
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    return { ok: false, error: "Could not read/parse file: " + String(e) };
  }
  const err = validate(obj);
  if (err) return { ok: false, error: err };
  return {
    ok: true,
    appVersion: obj.appVersion || null,
    exportedAt: obj.exportedAt || null,
    counts: obj.counts || {
      accounts: (obj.accounts?.emails || []).length,
      credentialFiles: Object.keys(obj.credentialFiles || {}).length,
      hasSecret: !!obj.clientSecret,
    },
  };
}

module.exports = {
  buildBackup,
  exportToFile,
  importBackup,
  importFromFile,
  inspectFile,
  FORMAT,
  FORMAT_VERSION,
};
