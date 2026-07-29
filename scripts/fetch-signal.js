// Downloads the pinned signal-cli release plus a Temurin 25 JRE into
// vendor/signal/ so electron-builder can bundle them as app resources
// (fetch-uv.js is the template — same idempotence and marker-file scheme).
//
// Why bundle: signal-cli is a Java application. The whole point of this app is
// that the user installs nothing, so the Java runtime ships alongside it, the
// way uv already does. Layout produced:
//   vendor/signal/signal-cli/   (bin/signal-cli.bat, lib/*.jar — release archive, flattened)
//   vendor/signal/jre/          (bin/java.exe … — Temurin JRE, flattened)
//
// Windows-only build (like fetch-uv), so PowerShell does download + extract.
// tar.gz is extracted with the tar.exe every Windows 10+ ships.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// Keep this CURRENT: Signal's servers reject clients that lag too far behind
// ("Link request error: Connection closed!" during linking is the symptom —
// seen live with 0.13.14 in 2026-07). Check the latest release when bumping.
const SIGNAL_CLI_VERSION = "0.14.6"; // pin; bump deliberately
const SIGNAL_URL = `https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}.tar.gz`;

// Adoptium's "latest 25 GA JRE" redirect — stable URL, moving target by design.
// The marker file records what we actually got, so re-runs skip the download.
const JRE_URL =
  "https://api.adoptium.net/v3/binary/latest/25/ga/windows/x64/jre/hotspot/normal/eclipse";

const vendorDir = path.join(__dirname, "..", "vendor", "signal");
const marker = path.join(vendorDir, `.signal-version-${SIGNAL_CLI_VERSION}`);

function ps(script) {
  execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { stdio: "inherit" }
  );
}

// The archives extract to versioned top-level dirs (signal-cli-0.14.6/,
// jdk-21.0.x+y-jre/). We deliberately do NOT rename them to stable names:
// Defender holds handles on freshly extracted binaries while cloud-scanning
// them, which makes the rename fail EPERM for MINUTES (observed live). Instead,
// electron/services/signal.js locates the dirs by prefix — these two helpers
// are the same contract.
function locateCli() {
  return locate("signal-cli", path.join("bin", "signal-cli.bat"));
}

function locateJava() {
  return locate("jdk-", path.join("bin", "java.exe"));
}

function locate(prefix, probe) {
  let entries = [];
  try {
    entries = fs.readdirSync(vendorDir);
  } catch {
    return null;
  }
  // Newest first, so a leftover older version can never shadow the pinned one.
  for (const e of entries.filter((x) => x.startsWith(prefix)).sort().reverse()) {
    const p = path.join(vendorDir, e, probe);
    if (fs.existsSync(p)) return { dir: path.join(vendorDir, e), probe: p };
  }
  return null;
}

function pinnedCliPresent() {
  const cli = locateCli();
  return cli && path.basename(cli.dir) === `signal-cli-${SIGNAL_CLI_VERSION}`;
}

function main() {
  // The marker is written only after a PASSING smoke test, so its absence means
  // "this exact cli+JRE pairing was never proven" — e.g. the cli is present but
  // the JRE beside it is an older major version (seen live: signal-cli 0.14.6
  // needs Java 25, and a leftover Temurin 21 made the smoke test fail).
  if (!(fs.existsSync(marker) && pinnedCliPresent() && locateJava())) {
    console.log(`[fetch-signal] downloading signal-cli ${SIGNAL_CLI_VERSION} + Temurin 25 JRE …`);
    // Best-effort clean of older versions: Defender may still hold handles on a
    // recently extracted tree, and a locked leftover must not fail the build —
    // locate() prefers the newest version, so a stale sibling is harmless.
    for (const e of fs.existsSync(vendorDir) ? fs.readdirSync(vendorDir) : []) {
      try {
        fs.rmSync(path.join(vendorDir, e), { recursive: true, force: true });
      } catch (err) {
        console.log(`[fetch-signal] could not remove ${e} (${err.code}) — leaving it.`);
      }
    }
    fs.mkdirSync(vendorDir, { recursive: true });

    const tarPath = path.join(vendorDir, "signal-cli.tar.gz");
    const jreZip = path.join(vendorDir, "jre.zip");

    ps(
      [
        "$ErrorActionPreference='Stop';",
        "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;",
        `Invoke-WebRequest -UseBasicParsing -Uri '${SIGNAL_URL}' -OutFile '${tarPath}';`,
        `Invoke-WebRequest -UseBasicParsing -Uri '${JRE_URL}' -OutFile '${jreZip}';`,
      ].join(" ")
    );

    // Use Windows' OWN bsdtar explicitly: a GNU tar on PATH (Git for Windows)
    // parses "C:\..." as host:path ("Cannot connect to C") and fails.
    const systemTar = path.join(process.env.WINDIR || "C:\\Windows", "System32", "tar.exe");
    execFileSync(fs.existsSync(systemTar) ? systemTar : "tar", ["-xzf", tarPath, "-C", vendorDir], {
      stdio: "inherit",
    });
    ps(`Expand-Archive -Force -Path '${jreZip}' -DestinationPath '${vendorDir}'`);
    fs.rmSync(tarPath, { force: true });
    fs.rmSync(jreZip, { force: true });
  }

  const cli = locateCli();
  const jre = locateJava();
  if (!pinnedCliPresent() || !jre) {
    throw new Error(`[fetch-signal] expected signal-cli-${SIGNAL_CLI_VERSION} and a JRE under ${vendorDir} — not found.`);
  }

  // Smoke test: does the vendored pair actually start? Catches a JRE/signal-cli
  // version mismatch at BUILD time instead of on a user's machine. Uses the
  // SAME direct-java invocation as production (never the .bat — its inline
  // CLASSPATH exceeds cmd.exe's line limit from long install paths).
  const out = execFileSync(
    path.join(jre.dir, "bin", "java.exe"),
    ["-classpath", `${path.join(cli.dir, "lib")}\\*`, "org.asamk.signal.Main", "--version"],
    { env: Object.assign({}, process.env, { JAVA_HOME: jre.dir }) }
  )
    .toString()
    .trim();
  console.log(`[fetch-signal] smoke test: ${out}`);

  fs.writeFileSync(marker, `${SIGNAL_CLI_VERSION}\n${SIGNAL_URL}\n${JRE_URL}\n`);
  console.log(`[fetch-signal] ready in vendor/signal.`);
}

main();
