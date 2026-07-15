// Accounts service.
// Tracks which accounts the user wants connected, and derives live status by
// inspecting the credential files workspace-mcp caches in the shared dir AND by
// verifying each refresh token against Google directly (see verifyAccount).
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
const https = require("https");
const credentials = require("./credentials");
const { quoteEmail, legacySafeEmail, decodeStem } = require("./emailName");

const CRED_EXT = ".json";
const NON_CREDENTIAL_STEMS = new Set(["oauth_states"]);

// In Google OAuth "Testing" mode, refresh tokens expire ~7 days after issuance.
// In "Production" they don't. We can't read the project's publishing status from a
// user-token API, so rather than trust a fixed countdown we VERIFY each refresh
// token against Google (see verifyAccount) — that's ground truth in either mode.
// The 7-day window below is only a fallback shown in Testing mode until a verify
// result (or the production flag) supersedes it. A successful verify past the
// window also auto-learns Production (see maybeLearnProduction).
const REAUTH_WINDOW_DAYS = 7;
const DAY_MS = 86400000;
const VERIFY_FRESH_MS = 24 * 3600 * 1000; // a verify result older than this is ignored
const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";

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

// Record (in our registry) the moment an account was successfully authorized,
// so the dashboard can count down the ~7-day Testing-mode re-auth window.
function recordAuthorized(email) {
  email = (email || "").trim().toLowerCase();
  if (!email) return;
  const reg = readRegistry();
  reg.authorizedAt = reg.authorizedAt || {};
  reg.authorizedAt[email] = new Date().toISOString();
  if (!reg.emails.includes(email)) reg.emails.push(email);
  writeRegistry(reg);
}

// --- Refresh-token verification (ground truth, mode-independent) -------------

// POST application/x-www-form-urlencoded and resolve { statusCode, body }.
function postForm(urlStr, params) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      return reject(e);
    }
    const body = Object.entries(params)
      .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
      .join("&");
    const req = https.request(
      {
        method: "POST",
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 15000,
      },
      (resp) => {
        let chunks = "";
        resp.on("data", (d) => (chunks += d));
        resp.on("end", () => resolve({ statusCode: resp.statusCode, body: chunks }));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("token endpoint timeout")));
    req.write(body);
    req.end();
  });
}

// Persist the outcome of a verify so the (sync) status readers can reflect it.
function recordVerify(email, res) {
  email = (email || "").trim().toLowerCase();
  if (!email) return;
  const reg = readRegistry();
  reg.verify = reg.verify || {};
  reg.verify[email] = {
    ok: !!res.ok,
    status: res.status || null,
    transient: !!res.transient,
    at: new Date().toISOString(),
  };
  if (res.ok) {
    reg.lastVerifiedAt = reg.lastVerifiedAt || {};
    reg.lastVerifiedAt[email] = new Date().toISOString();
  }
  writeRegistry(reg);
}

// A refresh token that still works past the 7-day Testing window proves the OAuth
// app is effectively in Production (a Testing token would already be dead). Learn
// that once and stop showing countdowns. Never overrides an explicit user choice.
function maybeLearnProduction(email) {
  try {
    const s = credentials.readSettings();
    if (s.productionMode === true) return;
    const reg = readRegistry();
    const recorded = reg.authorizedAt && reg.authorizedAt[email];
    if (!recorded) return;
    const ageMs = Date.now() - new Date(recorded).getTime();
    if (ageMs > (REAUTH_WINDOW_DAYS + 1) * DAY_MS) {
      credentials.patchSettings({ productionMode: true, productionModeSource: "auto" });
    }
  } catch {
    /* best-effort */
  }
}

// Prove a refresh token still works by doing a real refresh_token grant against
// Google. This is identical whether the OAuth app is in Testing or Production, so
// it's the correct signal to drive the UI. Outcomes:
//   { ok:true }                                        token alive
//   { ok:false, status:'invalid_grant' }               Google rejected it (dead) — definitive
//   { ok:false, status:'no_refresh'|'no_credential' }  nothing to verify — definitive
//   { ok:false, status:'unreachable'|..., transient:true }  state unknown (offline etc.)
async function verifyAccount(email) {
  email = (email || "").trim().toLowerCase();
  const p = credentialFilePath(email);
  if (!p || !safeExists(p)) {
    const r = { ok: false, status: "no_credential" };
    recordVerify(email, r);
    return r;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    const r = { ok: false, status: "unreadable", transient: true };
    recordVerify(email, r);
    return r;
  }
  if (!data.refresh_token) {
    const r = { ok: false, status: "no_refresh" };
    recordVerify(email, r);
    return r;
  }
  const clientId = data.client_id;
  let clientSecret = data.client_secret;
  if (!clientSecret) {
    try {
      clientSecret = await credentials.getClientSecret();
    } catch {
      /* fall through to missing_client */
    }
  }
  if (!clientId || !clientSecret) {
    const r = { ok: false, status: "missing_client", transient: true };
    recordVerify(email, r);
    return r;
  }
  let resp;
  try {
    resp = await postForm(data.token_uri || GOOGLE_TOKEN_URI, {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: data.refresh_token,
      grant_type: "refresh_token",
    });
  } catch (e) {
    const r = {
      ok: false,
      status: "unreachable",
      transient: true,
      error: String((e && e.message) || e),
    };
    recordVerify(email, r);
    return r;
  }
  if (resp.statusCode === 200) {
    recordVerify(email, { ok: true, status: "ok" });
    maybeLearnProduction(email);
    return { ok: true, status: "ok" };
  }
  let errCode = null;
  try {
    errCode = JSON.parse(resp.body).error;
  } catch {
    /* non-JSON body */
  }
  if (resp.statusCode === 400 && errCode === "invalid_grant") {
    const r = { ok: false, status: "invalid_grant" };
    recordVerify(email, r);
    return r;
  }
  // Any other response (5xx, rate-limit, unexpected 4xx) is treated as transient —
  // we never tear down a working account on an ambiguous blip.
  const r = {
    ok: false,
    status: errCode ? `error_${errCode}` : `http_${resp.statusCode}`,
    transient: true,
  };
  recordVerify(email, r);
  return r;
}

// Verify every known account (sequential — the fleet is tiny). Returns the fresh
// account list so callers can update the UI in one round-trip.
async function verifyAll() {
  const reg = readRegistry();
  for (const email of reg.emails || []) {
    try {
      await verifyAccount(email);
    } catch {
      /* recordVerify already captured transient failures */
    }
  }
  return listAccounts();
}

function readTokenStatus(email, reg, settings) {
  const p = credentialFilePath(email);
  if (!p || !safeExists(p)) return { connected: false };

  let data;
  try {
    data = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return { connected: true, hasRefresh: false, expiry: null, expired: true };
  }

  const hasRefresh = !!data.refresh_token;
  const accessExpiry = parseExpiry(data.expiry); // 1-hour access token (diagnostic only)

  if (!reg) reg = readRegistry();
  if (!settings) {
    try {
      settings = credentials.readSettings();
    } catch {
      settings = {};
    }
  }
  const productionMode = settings.productionMode === true;

  // When was this account last authorized? Prefer our recorded timestamp; fall
  // back to the credential file's mtime (its first write ≈ issuance).
  let authorizedAt = null;
  const recorded = reg.authorizedAt && reg.authorizedAt[email];
  if (recorded) authorizedAt = new Date(recorded);
  if (!authorizedAt || isNaN(authorizedAt.getTime())) {
    try {
      authorizedAt = new Date(fs.statSync(p).mtimeMs);
    } catch {
      authorizedAt = null;
    }
  }

  // Ground-truth verify result (from a real refresh against Google).
  const v = (reg.verify && reg.verify[email]) || null;
  const verifyFresh = !!(v && v.at && Date.now() - new Date(v.at).getTime() < VERIFY_FRESH_MS);
  const verifiedAliveNow = !!(verifyFresh && v.ok === true);
  const verifyFailedHard = !!(verifyFresh && v.ok === false && !v.transient);
  const lastVerifiedAt = (reg.lastVerifiedAt && reg.lastVerifiedAt[email]) || null;

  // The 7-day window is only meaningful in Testing mode, and a fresh successful
  // verify supersedes it (the token is provably alive right now).
  const reauthDeadline =
    !productionMode && authorizedAt
      ? new Date(authorizedAt.getTime() + REAUTH_WINDOW_DAYS * DAY_MS)
      : null;
  const windowPassed =
    !verifiedAliveNow && (reauthDeadline ? reauthDeadline.getTime() < Date.now() : false);

  // "Needs re-auth" if: no refresh token, OR a real refresh was rejected, OR
  // (Testing only, and not just-verified) the 7-day window elapsed.
  const expired = !hasRefresh || verifyFailedHard || windowPassed;

  return {
    connected: true,
    hasRefresh,
    scopes: Array.isArray(data.scopes) ? data.scopes : [],
    accessExpiry: accessExpiry ? accessExpiry.toISOString() : null,
    authorizedAt: authorizedAt ? authorizedAt.toISOString() : null,
    // `expiry` is the Testing-mode re-auth deadline; null in Production.
    expiry: reauthDeadline ? reauthDeadline.toISOString() : null,
    expired,
    productionMode,
    verifiedAt: lastVerifiedAt,
    verifyStatus: v ? v.status : null,
    verifyOk: v ? !!v.ok : null,
  };
}

function listAccounts() {
  const reg = readRegistry();
  let settings = {};
  try {
    settings = credentials.readSettings();
  } catch {
    /* defaults */
  }
  const labels = reg.labels || {};
  return reg.emails.map((email) => ({
    email,
    label: labels[email] || "",
    ...readTokenStatus(email, reg, settings),
  }));
}

// A short user-assigned label for an account ("Personal", "Work", "Assaya"…). It's
// what lets the AI map "my personal email" to the right account, and it's woven into
// the usage-rules guidance so a fresh session knows the mapping too.
function setLabel(email, label) {
  const reg = readRegistry();
  email = (email || "").trim().toLowerCase();
  if (!reg.emails.includes(email)) return { ok: false, error: "Unknown account." };
  reg.labels = reg.labels || {};
  const clean = (label || "").trim().slice(0, 40);
  if (clean) reg.labels[email] = clean;
  else delete reg.labels[email];
  writeRegistry(reg);
  return { ok: true, label: clean };
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
  setLabel,
  readTokenStatus,
  recordAuthorized,
  verifyAccount,
  verifyAll,
  credentialFilePath,
};
