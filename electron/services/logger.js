// File logger for the main process.
// Writes timestamped, secret-redacted lines to <userData>/logs/app.log and the
// dev console. Never logs the OAuth client secret or any token material.

const fs = require("fs");
const path = require("path");

let logFilePath = null;
let initialized = false;

// Redact obvious secret shapes anywhere in free text.
const SECRET_PATTERNS = [
  /GOCSPX-[A-Za-z0-9_\-]+/g, // Google OAuth client secret
  /ya29\.[A-Za-z0-9._\-]+/g, // Google access tokens
  /1\/\/[A-Za-z0-9._\-]+/g, // Google refresh tokens
];

// Keys whose values must never be written verbatim.
const REDACT_KEYS = new Set([
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "client_secret",
  "clientSecret",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
]);

function init() {
  if (initialized) return logFilePath;
  try {
    const { app } = require("electron");
    const dir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(dir, { recursive: true });
    logFilePath = path.join(dir, "app.log");
    initialized = true;
    line("INFO", "logger", "=== session start ===", {
      pid: process.pid,
      electron: process.versions.electron,
      node: process.versions.node,
      platform: process.platform,
      logFile: logFilePath,
    });
  } catch {
    // best-effort; logging must never crash the app
  }
  return logFilePath;
}

function redactString(s) {
  let out = String(s);
  for (const re of SECRET_PATTERNS) out = out.replace(re, "***redacted***");
  return out;
}

function sanitize(data, depth = 0) {
  if (data == null || depth > 6) return data;
  if (typeof data === "string") return redactString(data);
  if (typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map((d) => sanitize(d, depth + 1));
  const o = {};
  for (const [k, v] of Object.entries(data)) {
    if (REDACT_KEYS.has(k)) o[k] = v ? "***redacted***" : v;
    else o[k] = sanitize(v, depth + 1);
  }
  return o;
}

function line(level, scope, msg, data) {
  const ts = new Date().toISOString();
  let entry = `${ts} [${level}] [${scope}] ${redactString(msg)}`;
  if (data !== undefined) {
    try {
      entry += " " + JSON.stringify(sanitize(data));
    } catch {
      entry += " [unserializable data]";
    }
  }
  try {
    (level === "ERROR" ? console.error : console.log)(entry);
  } catch {}
  try {
    if (logFilePath) fs.appendFileSync(logFilePath, entry + "\n");
  } catch {}
}

module.exports = {
  init,
  getLogPath: () => logFilePath,
  info: (scope, msg, data) => line("INFO", scope, msg, data),
  warn: (scope, msg, data) => line("WARN", scope, msg, data),
  error: (scope, msg, data) => line("ERROR", scope, msg, data),
};
