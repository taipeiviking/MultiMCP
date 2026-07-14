// Token file guard.
//
// The per-account token files in the credentials dir are written by workspace-mcp
// (Python), not by us: credential_store.py opens them with O_TRUNC and json.dump()s
// into them, with no lock and no atomic rename. That is fine with one client. It is
// NOT fine now that a user can run Claude AND Codex at the same time, because EACH
// MCP CLIENT SPAWNS ITS OWN SERVER PROCESS -- two processes, one credentials dir. If
// both refresh the same account in the same instant, one can read or leave behind a
// half-written file, and that account then looks like it needs signing in again.
//
// We cannot fix their writer. So instead: keep a shadow copy of every token file we
// have seen in a good state, and put it back when one goes bad. Losing a *freshly
// refreshed access token* costs nothing -- it is regenerated on demand from the
// refresh_token, which is the part that actually matters and which does not change.
//
// This is repair, not prevention: a corrupt file is still possible, it just stops
// being the user's problem.

const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const credentials = require("./credentials");
const log = require("./logger");

function shadowDir() {
  return path.join(app.getPath("userData"), "token-backups");
}

function isTokenFile(name) {
  return name.endsWith(".json") && name !== "oauth_states.json";
}

// A token file is "good" if it parses AND still carries the durable part. A file
// that parses but has lost its refresh_token is useless to us as a backup.
function readGood(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (j && typeof j === "object" && j.refresh_token) return j;
    return null;
  } catch {
    return null;
  }
}

function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

// Sweep the credentials dir: back up what is healthy, restore what is not.
// Returns { checked, backedUp, repaired: [emails], unrecoverable: [emails] }.
function sweep() {
  const dir = credentials.credentialsDir();
  const shadow = shadowDir();
  const result = { checked: 0, backedUp: 0, repaired: [], unrecoverable: [] };

  let names = [];
  try {
    names = fs.readdirSync(dir).filter(isTokenFile);
  } catch {
    return result; // no credentials dir yet: nothing to guard
  }

  try {
    fs.mkdirSync(shadow, { recursive: true });
  } catch (e) {
    log.warn("tokenGuard", "cannot create shadow dir", { message: String(e) });
    return result;
  }

  for (const name of names) {
    result.checked++;
    const live = path.join(dir, name);
    const copy = path.join(shadow, name);
    const good = readGood(live);

    if (good) {
      // Healthy. Refresh the shadow copy, but only when it actually differs, so we
      // are not rewriting five files every six hours for nothing.
      const text = JSON.stringify(good, null, 2);
      let existing = null;
      try {
        existing = fs.readFileSync(copy, "utf8");
      } catch {
        /* no shadow yet */
      }
      if (existing !== text) {
        try {
          writeAtomic(copy, text);
          result.backedUp++;
        } catch (e) {
          log.warn("tokenGuard", "could not update shadow copy", { name, message: String(e) });
        }
      }
      continue;
    }

    // Not healthy: truncated, half-written, or missing its refresh_token.
    const email = name.replace(/\.json$/, "");
    const backup = readGood(copy);
    if (!backup) {
      // Nothing to restore from. Don't touch it - the account genuinely needs a
      // re-auth, and the app's normal expiry check will say so.
      result.unrecoverable.push(email);
      log.error("tokenGuard", "token file is unusable and there is no shadow copy", {
        name,
        hint: "this account needs signing in again",
      });
      continue;
    }

    try {
      // Keep the damaged bytes for forensics before overwriting them.
      try {
        fs.copyFileSync(live, `${copy}.corrupt-${Date.now()}`);
      } catch {
        /* the file may be unreadable; the restore is what matters */
      }
      writeAtomic(live, JSON.stringify(backup, null, 2));
      result.repaired.push(email);
      log.warn("tokenGuard", "restored a corrupt token file from the shadow copy", {
        email,
        note: "the access token is regenerated from refresh_token on the next call",
      });
    } catch (e) {
      result.unrecoverable.push(email);
      log.error("tokenGuard", "restore failed", { name, message: String(e) });
    }
  }

  if (result.repaired.length || result.unrecoverable.length || result.backedUp) {
    log.info("tokenGuard", "sweep", result);
  }
  return result;
}

module.exports = { sweep, shadowDir };
