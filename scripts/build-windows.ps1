# One-click packaging script for Windows (PowerShell 5.1 compatible)
# Usage: run from project root:  .\scripts\build-windows.ps1 [-Edition Core|AI]
# Version is read from src-tauri\tauri.conf.json (keep package.json /
# tauri.conf.json / Cargo.toml / the epub-reader Cargo.lock entry in sync when bumping).
# Output:
#   Core installer: src-tauri\target-core\release\bundle\nsis\EPUB Reader_<version>_x64-setup.exe
#   AI installer  : src-tauri\target-ai\release\bundle\nsis\EPUB Reader AI_<version>_x64-setup.exe
# Core is the default release-safe edition. Cargo has no default edition
# feature; this script selects exactly one matching `core` or `ai` feature so
# the frontend and backend cannot be mixed accidentally.
[CmdletBinding()]
param(
    [ValidateSet("Core", "AI")]
    [string]$Edition = "Core"
)

$ErrorActionPreference = "Stop"
$editionLower = $Edition.ToLowerInvariant()
$cargoFeatureArgs = @("--features", "core")
$tauriConfig = "src-tauri\tauri.core.conf.json"
if ($Edition -eq "AI") {
    $cargoFeatureArgs = @("--features", "ai")
    $tauriConfig = "src-tauri\tauri.ai.conf.json"
}
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$targetDir = Join-Path $repoRoot ("src-tauri\target-" + $editionLower)
$env:VITE_EDITION = $editionLower
$env:EPUB_READER_EXPECTED_EDITION = $editionLower
$env:CARGO_TARGET_DIR = $targetDir

Write-Host "== EPUB Reader $Edition edition ==" -ForegroundColor Magenta
Write-Host "  Frontend edition: VITE_EDITION=$editionLower"
if ($Edition -eq "AI") {
    Write-Host "  Rust features    : --features ai (Cargo defaults are empty)"
} else {
    Write-Host "  Rust features    : --features core (Cargo defaults are empty)"
}
Write-Host "  Cargo target     : $targetDir"
if ($Edition -eq "AI") {
    Write-Host "  App data         : isolated (dev.epubreader.ai)"
}

Write-Host "== Check toolchain ==" -ForegroundColor Cyan
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "node not found: install Node.js >= 20 (https://nodejs.org/)" }
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw "pnpm not found: run  npm i -g pnpm" }
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw "cargo not found: install Rust (https://rustup.rs)" }
$nodeV = (node -v) -replace "^v", ""
if ([int]($nodeV.Split(".")[0]) -lt 20) { throw "Node.js too old ($nodeV), need >= 20" }
Write-Host "  node $(node -v) / pnpm $(pnpm -v) / rustc $(rustc -V)  OK"

Write-Host "== Install dependencies ==" -ForegroundColor Cyan
pnpm install
if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }

Write-Host "== Tauri bundle (first run downloads and compiles Rust deps, 5-15 min) ==" -ForegroundColor Cyan
$tauriArgs = @("tauri", "build")
$tauriArgs += $cargoFeatureArgs
if ($tauriConfig) {
    $tauriArgs += @("--config", $tauriConfig)
}
& pnpm @tauriArgs
if ($LASTEXITCODE -ne 0) { throw "Tauri build failed (common causes: missing WebView2 / network issues; see README)" }

Write-Host "== Edition artifact gate ==" -ForegroundColor Cyan
& pnpm exec node scripts/verify-edition-artifacts.mjs $editionLower
if ($LASTEXITCODE -ne 0) { throw "edition artifact gate failed" }

Write-Host ""
Write-Host "== Done ==" -ForegroundColor Green
# tauri.conf.json is UTF-8 (no BOM): read it as UTF-8 explicitly,
# otherwise Windows PowerShell 5.1 decodes it as ANSI/GBK and the
# Chinese window title breaks JSON parsing.
$version = (Get-Content -Raw -Encoding UTF8 "src-tauri\tauri.conf.json" | ConvertFrom-Json).version
$bundleName = if ($Edition -eq "AI") { "EPUB Reader AI" } else { "EPUB Reader" }
$nsis = Join-Path $targetDir ("release\bundle\nsis\{0}_{1}_x64-setup.exe" -f $bundleName, $version)
$portable = Join-Path $targetDir "release\epub-reader.exe"
Write-Host "  Edition output  : $Edition" -ForegroundColor Green
if (Test-Path $nsis) { Write-Host "  Installer: $(Resolve-Path $nsis)" -ForegroundColor Green }
if (Test-Path $portable) { Write-Host "  Portable : $(Resolve-Path $portable)" -ForegroundColor Green }
Write-Host ""
Write-Host "Note: target machines need the WebView2 Runtime (built into Win10/11; if missing,"
Write-Host "install the evergreen version from https://developer.microsoft.com/microsoft-edge/webview2/)."
