// Server manager.
// Shells out to `uvx workspace-mcp`. Handles:
//  - prerequisite detection (uvx, python)
//  - per-account OAuth sign-in (transient HTTP server + system browser)
//  - a short diagnostic "test" run
//
// All token caching happens inside workspace-mcp at GOOGLE_MCP_CREDENTIALS_DIR,
// which is shared with the stdio server Claude Desktop launches.

const { spawn, execFile } = require("child_process");
const { shell } = require("electron");
const credentials = require("./credentials");

const SIGNIN_PORT = 8000; // redirect URI on the OAuth client: http://localhost:8000/oauth2callback

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

// Launch a transient HTTP instance and drive Google consent for ONE account.
// TODO(claude-code): finalize the exact auth-initiation step. The server exposes a
// Google auth start (the `start_google_auth` tool / an /authorize route). The flow:
//   1. spawn `uvx workspace-mcp --transport streamable-http --tools gmail drive calendar`
//   2. open the system browser to the server's authorize URL for `email`
//   3. user signs in -> server caches the token in GOOGLE_MCP_CREDENTIALS_DIR
//   4. detect completion (poll the credentials dir for the new/updated file)
//   5. stop the transient server
async function authorizeAccount(email) {
  const uvx = await resolveUvxPath();
  if (!uvx) return { ok: false, error: "uvx not found. Install uv first." };

  const env = await baseEnv();
  if (!env.GOOGLE_OAUTH_CLIENT_ID) {
    return { ok: false, error: "Set the OAuth Client ID/Secret first." };
  }

  await stopAll();
  signinProc = spawn(
    uvx,
    ["workspace-mcp", "--transport", "streamable-http", "--tools", "gmail", "drive", "calendar"],
    { env, windowsHide: true }
  );

  // Give the server a moment to bind, then open consent in the system browser.
  await new Promise((r) => setTimeout(r, 1500));
  // TODO(claude-code): replace with the real authorize URL the server expects,
  // including the target account hint (login_hint=email) so the right account is used.
  await shell.openExternal(
    `http://localhost:${SIGNIN_PORT}/oauth2/authorize?login_hint=${encodeURIComponent(email)}`
  );

  return {
    ok: true,
    pending: true,
    note: "Complete sign-in in your browser, then return here and refresh status.",
  };
}

async function testServer() {
  const uvx = await resolveUvxPath();
  if (!uvx) return { ok: false, log: "uvx not found." };
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
  if (signinProc && !signinProc.killed) {
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
