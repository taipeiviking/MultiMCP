# Elevated packaging build for Google Workspace Manager.
# Run from an Administrator PowerShell (grants SeCreateSymbolicLink so
# electron-builder can extract its winCodeSign cache). Logs to dist-build.log.
$ErrorActionPreference = "Continue"
$root = "C:\Users\class\git\MultiMCP"
$log  = Join-Path $root "dist-build.log"
Set-Location $root
$env:Path = "C:\Users\class\.local\bin;" + $env:Path
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"

"=== dist build start $(Get-Date -Format o) ===" | Out-File -FilePath $log -Encoding utf8
"cwd: $(Get-Location)"                | Out-File -Append $log
"node: $((Get-Command node).Source)"  | Out-File -Append $log

$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npm) { $npm = "C:\Program Files\nodejs\npm.cmd" }
"npm: $npm" | Out-File -Append $log

# Step 1: vite build (renderer)
"--- npm run build ---" | Out-File -Append $log
& $npm run build 2>&1 | Tee-Object -FilePath $log -Append
"build EXITCODE: $LASTEXITCODE" | Out-File -Append $log

# Step 2: electron-builder NSIS installer
"--- electron-builder --win nsis ---" | Out-File -Append $log
& $npm exec -- electron-builder --win nsis 2>&1 | Tee-Object -FilePath $log -Append
"dist EXITCODE: $LASTEXITCODE" | Out-File -Append $log

"--- dist contents ---" | Out-File -Append $log
Get-ChildItem -Recurse $root\dist -ErrorAction SilentlyContinue | Select-Object FullName,Length | Out-File -Append $log
"=== dist build end $(Get-Date -Format o) ===" | Out-File -Append $log
