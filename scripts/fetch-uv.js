// Downloads a pinned uv/uvx (Windows x64) into vendor/uv/ so electron-builder can
// bundle it as an app resource. Idempotent: skips if the pinned version is already
// present (a marker file records the version). Runs before packaging (see the
// "dist" npm script). Windows-only build, so we use PowerShell for download+unzip.
//
// Why bundle uv: the app shells out to `uvx workspace-mcp`, and Claude Desktop
// launches the same command. If uv isn't on PATH the launch fails with
// "spawn uvx ENOENT". Shipping uv removes that entire class of setup failure.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const UV_VERSION = "0.11.18"; // pin; bump deliberately
const ASSET = "uv-x86_64-pc-windows-msvc.zip";
const URL = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${ASSET}`;

const vendorDir = path.join(__dirname, "..", "vendor", "uv");
const marker = path.join(vendorDir, `.uv-version-${UV_VERSION}`);
const uvxExe = path.join(vendorDir, "uvx.exe");
const uvExe = path.join(vendorDir, "uv.exe");

function alreadyHave() {
  return fs.existsSync(marker) && fs.existsSync(uvxExe) && fs.existsSync(uvExe);
}

function main() {
  if (alreadyHave()) {
    console.log(`[fetch-uv] uv ${UV_VERSION} already present in vendor/uv — skipping.`);
    return;
  }
  console.log(`[fetch-uv] downloading uv ${UV_VERSION} …`);
  fs.rmSync(vendorDir, { recursive: true, force: true });
  fs.mkdirSync(vendorDir, { recursive: true });

  const zipPath = path.join(vendorDir, ASSET);
  // PowerShell: TLS1.2 + download + expand. -UseBasicParsing for older hosts.
  const ps = [
    "$ErrorActionPreference='Stop';",
    "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;",
    `Invoke-WebRequest -UseBasicParsing -Uri '${URL}' -OutFile '${zipPath}';`,
    `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${vendorDir}';`,
    `Remove-Item '${zipPath}' -Force;`,
  ].join(" ");
  execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], {
    stdio: "inherit",
  });

  if (!fs.existsSync(uvxExe) || !fs.existsSync(uvExe)) {
    throw new Error(
      `[fetch-uv] expected uv.exe and uvx.exe in ${vendorDir} after extract — not found.`
    );
  }
  fs.writeFileSync(marker, `${UV_VERSION}\n${URL}\n`);
  console.log(`[fetch-uv] uv ${UV_VERSION} ready in vendor/uv.`);
}

main();
