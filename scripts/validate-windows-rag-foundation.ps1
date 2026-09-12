[CmdletBinding()]
param(
    [string]$ProjectRoot = "",
    [switch]$BuildInstaller,
    [switch]$LaunchTauriDev
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}

function Resolve-NativeCommand {
    param(
        [Parameter(Mandatory = $true)][string[]]$Names,
        [Parameter(Mandatory = $true)][string[]]$Fallbacks
    )

    foreach ($name in $Names) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command) { return $command.Source }
    }
    foreach ($fallback in $Fallbacks) {
        $expanded = [Environment]::ExpandEnvironmentVariables($fallback)
        if (Test-Path -LiteralPath $expanded -PathType Leaf) {
            return (Resolve-Path -LiteralPath $expanded).Path
        }
    }
    throw "Command not found: $($Names -join ', ')"
}

function Invoke-ValidationStep {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Action
    )

    Write-Host "`n==> $Name" -ForegroundColor Cyan
    $global:LASTEXITCODE = 0
    & $Action
    $exitCode = $global:LASTEXITCODE
    if ($null -ne $exitCode -and $exitCode -ne 0) {
        throw "$Name failed with exit code $exitCode"
    }
    Write-Host "PASS: $Name" -ForegroundColor Green
}

function Read-Utf8File {
    param([Parameter(Mandatory = $true)][string]$Path)

    $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
    $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
    return [System.IO.File]::ReadAllText($resolvedPath, $utf8)
}

function Find-WebView2Runtime {
    $roots = @(
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients",
        "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients",
        "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients"
    )
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        $runtime = Get-ChildItem $root -ErrorAction SilentlyContinue |
            ForEach-Object { Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue } |
            Where-Object { $_.name -match "WebView" } |
            Select-Object -First 1
        if ($runtime) { return $runtime }
    }
    return $null
}

$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$Pnpm = Resolve-NativeCommand -Names @("pnpm.cmd", "pnpm") -Fallbacks @(
    "%APPDATA%\npm\pnpm.cmd",
    "%LOCALAPPDATA%\pnpm\pnpm.exe"
)
$Cargo = Resolve-NativeCommand -Names @("cargo.exe", "cargo") -Fallbacks @(
    "%USERPROFILE%\.cargo\bin\cargo.exe"
)

Set-Location -LiteralPath $ProjectRoot
$Node = Resolve-NativeCommand -Names @("node.exe", "node") -Fallbacks @(
    "%ProgramFiles%\nodejs\node.exe"
)
$env:Path = (@(
    (Split-Path -Parent $Node),
    (Split-Path -Parent $Pnpm),
    (Split-Path -Parent $Cargo),
    $env:Path
) -join ";")
Write-Host "Project: $ProjectRoot"
Write-Host "node:   $Node"
Write-Host "pnpm:   $Pnpm"
Write-Host "cargo:  $Cargo"
$env:VITE_EDITION = "ai"
$env:EPUB_READER_EXPECTED_EDITION = "ai"
Write-Host "edition: AI (VITE_EDITION=ai / Cargo feature ai)"

$requiredFiles = @(
    "src\core\corpus.ts",
    "src\core\chunking.ts",
    "src\features\ai\contracts\provider.ts",
    "src\features\ai\registry\providerRegistry.ts",
    "src\features\ai\lifecycle\runtime.ts",
    "src\features\ai\ui\AiFoundationPanel.tsx",
    "src-tauri\src\ai\mod.rs",
    "src-tauri\src\ai\store.rs",
    "src-tauri\src\ai\task.rs"
)
foreach ($file in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "The Windows copy is incomplete; missing: $file"
    }
}

$webView = Find-WebView2Runtime
if (-not $webView) {
    throw "Microsoft Edge WebView2 Runtime was not found in the registry"
}
Write-Host "WebView2: $($webView.pv) ($($webView.name))"

$lockText = Read-Utf8File "src-tauri\Cargo.lock"
foreach ($crate in @('name = "rusqlite"', 'name = "libsqlite3-sys"')) {
    if (-not $lockText.Contains($crate)) {
        throw "Cargo.lock is missing: $crate"
    }
}

Invoke-ValidationStep "Frontend Vitest" { & $Pnpm test }
Invoke-ValidationStep "TypeScript + Vite AI production build" { & $Pnpm build:ai }
Invoke-ValidationStep "Rust fmt" { & $Cargo fmt --all --manifest-path "src-tauri\Cargo.toml" -- --check }
Invoke-ValidationStep "Rust AI check (locked)" { & $Cargo check --locked --manifest-path "src-tauri\Cargo.toml" --no-default-features --features ai }
Invoke-ValidationStep "Rust AI tests (locked)" { & $Cargo test --locked --manifest-path "src-tauri\Cargo.toml" --no-default-features --features ai }

# The toolbar component is shared by development and production builds, so its
# label may legitimately remain as an unreachable string in the minified bundle.
# A raw string search cannot prove that the button is visible. Verify the two
# actual edition gates instead; the frontend test above separately exercises
# Core/AI and shelf/reader combinations.
$appSource = Read-Utf8File "src\App.tsx"
if (-not $appSource.Contains("shouldShowAiFoundationEntry(APP_EDITION, view)")) {
    throw "The AI foundation toolbar entry is no longer guarded by the edition visibility rule"
}
if (-not $appSource.Contains("const LazyAiFoundationPanel = IS_AI_EDITION")) {
    throw "The AI foundation panel is no longer guarded by the compile-time edition"
}
Write-Host "PASS: AI foundation entry and panel retain their compile-time edition gates" -ForegroundColor Green

$tauriConfig = Read-Utf8File "src-tauri\tauri.ai.conf.json" | ConvertFrom-Json
$appDataRoot = Join-Path $env:APPDATA $tauriConfig.identifier
$aiDatabase = Join-Path $appDataRoot "ai\ai.sqlite3"
Write-Host "`nWindows app-data: $appDataRoot"
Write-Host "AI SQLite:       $aiDatabase"
Write-Host "AI DB currently exists: $(Test-Path -LiteralPath $aiDatabase)"

if ($BuildInstaller) {
    Invoke-ValidationStep "Windows Tauri AI installer build" { & ".\scripts\build-windows.ps1" -Edition AI }
}

Write-Host "`nAutomated validation completed." -ForegroundColor Green
if ($LaunchTauriDev) {
    Write-Host "Starting Tauri dev in the foreground. Close the window and press Ctrl+C to stop." -ForegroundColor Yellow
    & $Pnpm tauri:dev:ai
    if ($LASTEXITCODE -ne 0) { throw "Tauri dev exited with code $LASTEXITCODE" }
} else {
    Write-Host "To inspect the development panel, run:"
    Write-Host ".\scripts\validate-windows-rag-foundation.ps1 -LaunchTauriDev"
    Write-Host "Add -BuildInstaller to build the Windows installer as well."
}
