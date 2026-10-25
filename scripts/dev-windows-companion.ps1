[CmdletBinding()]
param(
    [string]$TestDirectory,
    [ValidateRange(1024, 65535)][int]$Port = 5186,
    [switch]$InstallDependencies,
    [switch]$InstallHarness,
    [switch]$EnableReaderTools
)
$ErrorActionPreference = 'Stop'
if (!$TestDirectory -or $TestDirectory -notmatch '^[A-Za-z]:[\\/]') {
    throw 'Pass -TestDirectory with an explicit local Windows build directory. AppData is not a build workspace.'
}
$source = Split-Path $PSScriptRoot -Parent
$node = (Get-Command node.exe -ErrorAction Stop).Source
$pnpmCommand = Get-Command pnpm.cmd, pnpm.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (!$pnpmCommand) { throw 'pnpm is not on PATH. Install pnpm before starting the AI development app.' }
$pnpm = $pnpmCommand.Source
$null = Get-Command cargo.exe -ErrorAction Stop

function Invoke-Checked([string]$File, [string[]]$Arguments) {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File failed with exit code $LASTEXITCODE" }
}

# Dedicated source copy and the existing AI app identity; no Core install, data or processes are touched.
New-Item -ItemType Directory -Force $TestDirectory | Out-Null
# Vite's root and resolved modules must agree, including packaged-host path redirection.
$TestDirectory = Invoke-Checked $node @('-e', "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))", $TestDirectory)
if ([IO.Path]::GetFullPath($source).TrimEnd('\') -ne [IO.Path]::GetFullPath($TestDirectory).TrimEnd('\')) {
    foreach ($file in @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'index.html', 'tsconfig.json', 'vite.config.ts', 'LICENSE', 'LICENSING.md', 'NOTICE', 'THIRD_PARTY_LICENSES.md')) {
        if (Test-Path -LiteralPath "$source\$file") { Copy-Item -LiteralPath "$source\$file" -Destination $TestDirectory -Force }
    }
    foreach ($directory in @('src', 'src-tauri', 'scripts', 'public-ai', 'third-party-licenses', '.ai-companion-local', 'experiments/companion-harness')) {
        if (!(Test-Path -LiteralPath "$source\$directory")) { continue }
        & "$env:SystemRoot\System32\robocopy.exe" "$source\$directory" "$TestDirectory\$directory" /E /XD node_modules target target-ai target-core target2 target-android-core target-android-ai gen .cache /NFL /NDL /NJH /NJS /NP
        if ($LASTEXITCODE -gt 7) { throw "Source copy failed for $directory (robocopy $LASTEXITCODE). Close only an existing AI development window and retry." }
    }
}

Push-Location $TestDirectory
$preview = $null
$environmentNames = @('VITE_EDITION', 'VITE_APP_PLATFORM', 'EPUB_READER_EXPECTED_EDITION', 'CARGO_TARGET_DIR', 'EPUB_READER_TOOLS')
$previousEnvironment = @{}
foreach ($name in $environmentNames) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    $env:VITE_EDITION = 'ai'
    $env:VITE_APP_PLATFORM = 'windows'
    $env:EPUB_READER_EXPECTED_EDITION = 'ai'
    if ($EnableReaderTools) { $env:EPUB_READER_TOOLS = '1' } else { $env:EPUB_READER_TOOLS = $null }
    $env:CARGO_TARGET_DIR = Join-Path $TestDirectory 'src-tauri\target-ai'
    $pnpmStore = Join-Path $TestDirectory '.pnpm-store'
    Write-Host "  Windows workspace: $TestDirectory"
    Write-Host "  Cargo target     : $env:CARGO_TARGET_DIR"
    Write-Host "  pnpm store       : $pnpmStore"
    if ($InstallDependencies -or !(Test-Path 'node_modules/@tauri-apps/cli/tauri.js')) {
        Invoke-Checked $pnpm @('install', '--frozen-lockfile', '--store-dir', $pnpmStore)
    }
    if ($InstallHarness) {
        Push-Location 'experiments/companion-harness'
        try { Invoke-Checked $pnpm @('install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', $pnpmStore) }
        finally { Pop-Location }
    }
    $listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    if ($listeners | Where-Object { $_.Port -eq $Port }) { throw "Port $Port is in use. Choose -Port <unused port>; do not stop another development service." }
    New-Item -ItemType Directory -Force '.cache' | Out-Null
    $config = @{ build = @{ beforeDevCommand = $null; devUrl = "http://127.0.0.1:$Port" } }
    [IO.File]::WriteAllText((Join-Path $TestDirectory '.cache\companion-dev.json'), ($config | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
    $preview = Start-Process -FilePath $node -ArgumentList @('node_modules/vite/bin/vite.js', '--port', "$Port", '--host', '127.0.0.1', '--strictPort') -WorkingDirectory $TestDirectory -RedirectStandardOutput "$TestDirectory\.cache\companion-vite.log" -RedirectStandardError "$TestDirectory\.cache\companion-vite-error.log" -PassThru
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if ($preview.HasExited) { throw "AI preview failed to start; see $TestDirectory\.cache\companion-vite-error.log" }
        try {
            $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/")
            $request.Proxy = $null
            $request.Timeout = 1000
            $response = $request.GetResponse()
            try { $ready = [int]$response.StatusCode -eq 200 } finally { $response.Close() }
        } catch { Start-Sleep -Milliseconds 250 }
        if ($ready) { break }
    }
    if (!$ready) { throw 'AI preview did not become ready; inspect the preview logs.' }
    Write-Host 'AI development only. Enter API settings in the reading companion panel; no tests are run by this launcher.'
    # This is a copied development snapshot; do not watch its own Cargo output.
    Invoke-Checked $node @('node_modules/@tauri-apps/cli/tauri.js', 'dev', '--no-watch', '--features', 'ai', '--config', 'src-tauri/tauri.ai.conf.json', '--config', '.cache/companion-dev.json')
} finally {
    if ($preview -and !$preview.HasExited) { Stop-Process -Id $preview.Id -ErrorAction SilentlyContinue }
    foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process') }
    Pop-Location
}
