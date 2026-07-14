// A no-op "browser" for the MCP server Claude Desktop launches.
//
// workspace-mcp calls webbrowser.open() itself whenever it decides a tool call is
// unauthenticated (auth/google_auth.py:554-562, gated only on transport == stdio).
// That is how a background server -- with no UI and no business doing so -- hijacks
// the user's browser with OAuth tabs they never asked for. We fix the main cause of
// the false "unauthenticated" verdict elsewhere (MCP_SINGLE_USER_MODE, see
// claudeConfig.js), but a genuinely revoked token, a missing credential file, or a
// future upstream regression can still reach that call. So make it physically
// impossible: point BROWSER at a shim that logs the URL and does nothing else.
//
// CPython puts $BROWSER entries at the FRONT of webbrowser._tryorder (preferred),
// and open() returns on the first success -- so "windows-default" is never reached.
//
// Two constraints, both load-bearing:
//   1. The shim MUST exit 0. GenericBrowser.open() is `return not p.wait()`, so a
//      non-zero exit means "failed", and webbrowser falls through to the REAL
//      browser. A broken shim is worse than no shim.
//   2. It MUST be a bare path with no arguments and no spaces -- webbrowser treats
//      the whole BROWSER string as the executable name.
//
// This is deliberately NOT applied to the tray app's own sign-in, which must open a
// real browser (see serverManager.baseEnv).

const fs = require("fs");
const path = require("path");
const os = require("os");
const log = require("./logger");

// No spaces anywhere in this path: webbrowser cannot quote it.
function shimDir() {
  return path.join(process.env.LOCALAPPDATA || os.homedir(), "MultiMCP");
}

function shimPath() {
  return path.join(shimDir(), "no-browser.cmd");
}

function logPath() {
  return path.join(shimDir(), "suppressed-auth-urls.log");
}

// Note on the .cmd body: the URL arrives UNQUOTED, and Google auth URLs contain
// '&', which cmd.exe would treat as a command separator -- so %* / %1 lose
// everything after the first '&'. !CMDCMDLINE! is the raw, unsplit command line.
// `exit 0` (not `exit /b`) terminates cmd.exe with status 0 and discards whatever
// trailing "&<fragment>" cmd parsed off the URL.
const SHIM_BODY = [
  "@echo off",
  "setlocal enabledelayedexpansion",
  'rem Written by Google Workspace Manager (MultiMCP). Do not edit.',
  'rem Swallows OAuth URLs that Claude\'s background MCP server tries to open.',
  '>>"%~dp0suppressed-auth-urls.log" echo(!CMDCMDLINE!',
  "exit 0",
  "",
].join("\r\n");

// Create (or repair) the shim. Must run on EVERY launch: buildEntry() only sets
// BROWSER when the file exists, and a missing shim fails OPEN (real browser).
function ensureShim() {
  try {
    fs.mkdirSync(shimDir(), { recursive: true });
    const p = shimPath();
    let current = null;
    try {
      current = fs.readFileSync(p, "utf8");
    } catch {
      /* not there yet */
    }
    if (current !== SHIM_BODY) {
      fs.writeFileSync(p, SHIM_BODY);
      log.info("noBrowser", current == null ? "created no-browser shim" : "repaired no-browser shim", {
        path: p,
      });
    }
    return p;
  } catch (e) {
    // Fail loudly but don't crash: without the shim we simply don't set BROWSER,
    // which restores the old (tab-opening) behaviour rather than breaking the app.
    log.error("noBrowser", "could not create no-browser shim", { message: String(e) });
    return null;
  }
}

// Only report the shim if it's actually on disk right now - see the fail-open note.
function shimPathIfPresent() {
  try {
    const p = shimPath();
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

// Auth URLs the background server tried to open (newest last). The tray app uses
// these to tell the user which account actually needs a real sign-in.
function readSuppressed() {
  let text;
  try {
    text = fs.readFileSync(logPath(), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/https:\/\/accounts\.google\.com\/[^\s"]*/);
    if (!m) continue;
    let email = null;
    const hint = m[0].match(/[?&]login_hint=([^&\s]+)/);
    if (hint) {
      try {
        email = decodeURIComponent(hint[1]);
      } catch {
        email = hint[1];
      }
    }
    out.push({ email, url: m[0] });
  }
  return out;
}

function clearSuppressed() {
  try {
    fs.writeFileSync(logPath(), "");
  } catch {
    /* best effort */
  }
}

module.exports = { ensureShim, shimPathIfPresent, readSuppressed, clearSuppressed, shimPath, logPath };
