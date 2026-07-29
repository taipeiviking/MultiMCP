// Downloads the pinned sigtop.exe (ISC-licensed, github.com/tbvdm/sigtop) into
// vendor/sigtop/ for bundling. sigtop reads Signal Desktop's encrypted local
// database (decrypting the DPAPI-protected key as the same Windows user) and
// exports messages — the engine behind "Import Signal Desktop history".
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SIGTOP_VERSION = "0.24.0"; // pin; bump deliberately
const URL = `https://github.com/tbvdm/sigtop/releases/download/v${SIGTOP_VERSION}/sigtop.exe`;

const vendorDir = path.join(__dirname, "..", "vendor", "sigtop");
const exe = path.join(vendorDir, "sigtop.exe");
const marker = path.join(vendorDir, `.sigtop-version-${SIGTOP_VERSION}`);

function main() {
  if (fs.existsSync(marker) && fs.existsSync(exe)) {
    console.log(`[fetch-sigtop] sigtop ${SIGTOP_VERSION} already present — skipping.`);
    return;
  }
  console.log(`[fetch-sigtop] downloading sigtop ${SIGTOP_VERSION} …`);
  fs.mkdirSync(vendorDir, { recursive: true });
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri '${URL}' -OutFile '${exe}'`,
    ],
    { stdio: "inherit" }
  );
  // Smoke test: sigtop has no version flag; bare invocation prints usage and
  // exits nonzero. Anything else (bad download, blocked exe) throws here.
  let usage = "";
  try {
    execFileSync(exe, [], { stdio: "pipe" });
  } catch (e) {
    usage = String(e.stderr || "");
  }
  if (!/usage: sigtop/.test(usage)) {
    throw new Error(`[fetch-sigtop] ${exe} did not run (got: ${usage.slice(0, 120)})`);
  }
  console.log(`[fetch-sigtop] smoke test OK`);
  fs.writeFileSync(marker, `${SIGTOP_VERSION}\n${URL}\n`);
  console.log(`[fetch-sigtop] ready in vendor/sigtop.`);
}

main();
