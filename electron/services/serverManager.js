// Server manager.
// Shells out to `uvx workspace-mcp`. Handles:
//  - prerequisite detection (uvx, python)
//  - per-account OAuth sign-in (stdio MCP server + system browser)
//  - a short diagnostic "test" run
//
// All token caching happens inside workspace-mcp at GOOGLE_MCP_CREDENTIALS_DIR,
// which is shared with the stdio server Claude Desktop launches.
//
// HOW SIGN-IN ACTUALLY WORKS (confirmed against workspace-mcp 1.21.1 source):
//   workspace-mcp exposes no plain "/authorize" HTTP route. Auth is driven by an
//   MCP tool, `start_google_auth`. In *stdio* transport with legacy OAuth 2.0
//   (i.e. MCP_ENABLE_OAUTH21 unset), that tool:
//     - starts a minimal callback server on http://localhost:8000/oauth2callback
//     - builds the Google consent URL (with login_hint=<email>) and opens it in
//       the *system* browser automatically (webbrowser.open)
//     - on the callback, exchanges the code and writes <urlencoded-email>.json
//       into GOOGLE_MCP_CREDENTIALS_DIR
//   So we launch the server in stdio mode, speak newline-delimited JSON-RPC,
//   call start_google_auth, then watch the credentials dir for the new/updated
//   credential file. The same shared dir is what Claude Desktop's stdio server
//   reads, so the token is immediately usable by Claude.

const { spawn, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { shell } = require("electron");
const credentials = require("./credentials");
const { credentialFilePath } = require("./accounts");

const SIGNIN_PORT = 8000; // redirect URI on the OAuth client: http://localhost:8000/oauth2callback
const SIGNIN_TIMEOUT_MS = 180000; // how long we wait for the user to finish consent
const POLL_INTERVAL_MS = 1000;

function which(cmd) {
  return new Promise((resolve) => {
    const finder = process.platform === "win32" ? "where" : "which";
    execFile(finder, [cmd], (err, stdout) => {
      if (err || !stdout) return resolve(null);
      resolve(stdout.split(/\r?\n/)[0].trim() || null);
    });
  });
}

async function resolveUvxPath() {
  return (await which("uvx")) || null;
}

async function checkPrerequisites() {
  const uvx = await resolveUvxPath();
  // uv can provision Python, but report it for clarity.
  const python = (await which("python")) || (await which("python3"));
  return {
    uvx: { ok: !!uvx, path: uvx },
    python: { ok: !!python, path: python },
    installHint:
      'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"',
  };
}

async function baseEnv() {
  const { clientId, credentialsDir } = await credentials.getClientConfig();
  const clientSecret = await credentials.getClientSecret();
  return {
    ...process.env,
    GOOGLE_OAUTH_CLIENT_ID: clientId,
    GOOGLE_OAUTH_CLIENT_SECRET: clientSecret || "",
    GOOGLE_MCP_CREDENTIALS_DIR: credentialsDir,
    OAUTHLIB_INSECURE_TRANSPORT: "1",
    WORKSPACE_MCP_PORT: String(SIGNIN_PORT),
  };
}

let signinProc = null;

// --- Minimal MCP stdio client (newline-delimited JSON-RPC) -------------------

function makeRpcClient(proc) {
  let buf = "";
  const pending = new Map();
  let nextId = 1;

  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore any non-JSON noise on stdout
      }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || "RPC error"));
        else resolve(msg.result);
      }
    }
  });

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  function notify(method, params) {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  return { request, notify };
}

function extractAuthUrl(toolResult) {
  // tools/call returns { content: [{ type: "text", text: "...Authorization URL: <url>..." }] }
  try {
    const text = (toolResult.content || [])
      .map((c) => (typeof c.text === "string" ? c.text : ""))
      .join("\n");
    const m = text.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/[^\s)]+/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

// Launch a transient stdio MCP instance and drive Google consent for ONE account.
// Resolves once a fresh credential file is observed, or with pending=true on timeout.
async function authorizeAccount(email) {
  const uvx = await resolveUvxPath();
  if (!uvx) return { ok: false, error: "uvx not found. Install uv first." };

  const env = await baseEnv();
  if (!env.GOOGLE_OAUTH_CLIENT_ID) {
    return { ok: false, error: "Set the OAuth Client ID first." };
  }
  if (!env.GOOGLE_OAUTH_CLIENT_SECRET) {
    return { ok: false, error: "Set the OAuth Client Secret first." };
  }

  const dir = credentials.credentialsDir();
  fs.mkdirSync(dir, { recursive: true });

  // Record the pre-auth signature of this account's credential file so we can
  // detect a *fresh* token (works for both first sign-in and re-auth).
  const before = credentialSignature(email);

  await stopAll();
  signinProc = spawn(
    uvx,
    ["workspace-mcp", "--tools", "gmail", "drive", "calendar"],
    { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
  );

  let stderr = "";
  signinProc.stderr.on("data", (d) => {
    stderr += d.toString();
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });

  const proc = signinProc;
  const rpc = makeRpcClient(proc);

  let authUrl = null;
  try {
    await Promise.race([
      rpc.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "google-workspace-manager", version: "0.1.0" },
      }),
      rejectAfter(15000, "workspace-mcp did not respond to initialize"),
    ]);
    rpc.notify("notifications/initialized", {});

    const result = await Promise.race([
      rpc.request("tools/call", {
        name: "start_google_auth",
        arguments: { service_name: "Gmail", user_google_email: email },
      }),
      rejectAfter(15000, "start_google_auth did not respond"),
    ]);
    authUrl = extractAuthUrl(result);
    // The server opens the system browser itself. If that failed (headless quirk),
    // fall back to opening the parsed URL ourselves.
    if (authUrl && /Open this URL|did not appear/i.test(JSON.stringify(result))) {
      shell.openExternal(authUrl).catch(() => {});
    }
  } catch (e) {
    await stopAll();
    return {
      ok: false,
      error: `Could not start sign-in: ${e.message}`,
      log: stderr.slice(-1500),
    };
  }

  // Poll for a fresh credential file, then stop the transient server.
  const deadline = Date.now() + SIGNIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (proc.killed || proc.exitCode != null) break;
    await sleep(POLL_INTERVAL_MS);
    const now = credentialSignature(email);
    if (now && now !== before) {
      await stopAll();
      return { ok: true, connected: true, authUrl };
    }
  }

  await stopAll();
  return {
    ok: true,
    pending: true,
    authUrl,
    note:
      "Finish the sign-in in your browser if you haven't. Then click Re-auth/refresh to update status.",
  };
}

// A cheap fingerprint of the credential file (mtime+size), or null if absent.
function credentialSignature(email) {
  try {
    const p = credentialFilePath(email);
    if (!p) return null;
    const st = fs.statSync(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function rejectAfter(ms, msg) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms));
}

async function testServer() {
  const uvx = await resolveUvxPath();
  if (!uvx) return { ok: false, log: "uvx not found. Install uv first." };
  const env = await baseEnv();
  return new Promise((resolve) => {
    const logs = [];
    const proc = spawn(uvx, ["workspace-mcp", "--help"], { env, windowsHide: true });
    proc.stdout.on("data", (d) => logs.push(d.toString()));
    proc.stderr.on("data", (d) => logs.push(d.toString()));
    proc.on("close", (code) =>
      resolve({ ok: code === 0, log: logs.join("").slice(0, 4000) })
    );
    proc.on("error", (e) => resolve({ ok: false, log: String(e) }));
  });
}

async function stopAll() {
  if (signinProc && signinProc.exitCode == null && !signinProc.killed) {
    try {
      signinProc.stdin.end();
    } catch {}
    try {
      signinProc.kill();
    } catch {}
  }
  signinProc = null;
}

module.exports = {
  resolveUvxPath,
  checkPrerequisites,
  authorizeAccount,
  testServer,
  stopAll,
};
