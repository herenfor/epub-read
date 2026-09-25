param(
    [string]$TestDirectory = 'D:\DevProjects\epub-reader-rag-test',
    [switch]$InstallDependencies,
    [ValidateSet('hardware', 'embedding', 'store')]
    [string[]]$NativeTests = @()
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$source = Split-Path $PSScriptRoot -Parent
$rust = "$env:USERPROFILE\.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin"
$node = "$env:ProgramFiles\nodejs\node.exe"
$pnpm = "$env:APPDATA\npm\node_modules\pnpm\pnpm.exe"
foreach ($tool in @("$rust\cargo.exe", $node, $pnpm)) {
    if (!(Test-Path $tool)) { throw "Required tool missing: $tool" }
}
$env:Path = "$rust;$(Split-Path $node);$env:APPDATA\npm;$env:Path"
$env:VITE_EDITION = 'ai'
$env:EPUB_READER_EXPECTED_EDITION = 'ai'
$env:CARGO_TARGET_DIR = "$TestDirectory\src-tauri\target-ai"
New-Item -ItemType Directory -Force $TestDirectory | Out-Null

# Wait for the command itself, not driver helper descendants; retain its exit handle.
function Invoke-Checked([string]$File, [string[]]$Arguments, [int]$MaxExitCode = 0) {
    $process = Start-Process -FilePath $File -ArgumentList $Arguments -WorkingDirectory $TestDirectory -NoNewWindow -PassThru
    $handle = $process.Handle
    $process.WaitForExit()
    $code = $process.ExitCode
    if ($null -eq $code -or $code -lt 0 -or $code -gt $MaxExitCode) {
        throw "$File failed with exit code: $code"
    }
}

# Mirrors the synced subset only: scripts/, src/, src-tauri/src and the build
# manifests. Build output, caches, local browsers and the local probe crates are
# never copied, so the Windows copy cannot diverge from this checkout.
if ([IO.Path]::GetFullPath($source).TrimEnd('\') -ne [IO.Path]::GetFullPath($TestDirectory).TrimEnd('\')) {
    foreach ($file in @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'index.html', 'tsconfig.json', 'vite.config.ts', 'LICENSE', 'NOTICE', 'THIRD_PARTY_LICENSES.md')) {
        Copy-Item -LiteralPath "$source\$file" -Destination $TestDirectory -Force
    }
    foreach ($directory in @('src', 'src-tauri', 'scripts', 'public', 'public-ai', 'third-party-licenses')) {
        Invoke-Checked "$env:SystemRoot\System32\robocopy.exe" @("`"$source\$directory`"", "`"$TestDirectory\$directory`"", '/E', '/XD', 'node_modules', 'target', 'target-ai', 'target-core', 'gen', '.cache', '.probe', '.pw-libs', '.pw-browsers', '/NFL', '/NDL', '/NJH', '/NJS', '/NP') 7
    }
}
Set-Location $TestDirectory
if ($InstallDependencies -or !(Test-Path 'node_modules/@tauri-apps/cli/tauri.js')) {
    Invoke-Checked $pnpm @('install', '--frozen-lockfile')
}
# Development startup does not imply a native regression run. Select only the
# affected suites, e.g. -NativeTests store. Model-dependent tests stay opt-in.
$testFilters = @{ hardware = 'ai::hardware::tests'; embedding = 'ai::embedding'; store = 'ai::semantic_store' }
foreach ($suite in ($NativeTests | Select-Object -Unique)) {
    Invoke-Checked "$rust\cargo.exe" @('test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--no-default-features', '--features', 'ai', $testFilters[$suite], '--', '--nocapture')
}

# Real-model evidence: prepare the pinned package once, then run the in-app
# probe from the AI panel (window "单书语义检索（调试）" → "真实模型探针").
$probeScript = Join-Path $source 'scripts\prepare-semantic-model.ps1'
if (Test-Path -LiteralPath $probeScript) {
    Write-Host "模型包准备脚本：$probeScript（需先选择模型库目录并注册）" -ForegroundColor Yellow
}

# Reuse the AI Web preview already running in WSL; do not compete for port 5173.
$request = [Net.HttpWebRequest]::Create('http://127.0.0.1:5173/')
$request.Proxy = $null
$request.Timeout = 10000
$response = $request.GetResponse()
try {
    if ([int]$response.StatusCode -ne 200) { throw 'WSL Web preview is unavailable on port 5173.' }
} finally { $response.Close() }
New-Item -ItemType Directory -Force '.cache' | Out-Null
[IO.File]::WriteAllText("$TestDirectory\.cache\windows-preview.json", '{"build":{"beforeDevCommand":null,"devUrl":"http://127.0.0.1:5173"}}', (New-Object System.Text.UTF8Encoding($false)))
Invoke-Checked $node @('node_modules/@tauri-apps/cli/tauri.js', 'dev', '--features', 'ai', '--config', 'src-tauri/tauri.ai.conf.json', '--config', '.cache/windows-preview.json')
