param(
    [ValidateSet('start', 'stop', 'status')][string]$Action = 'start',
    [string]$Config = (Join-Path $PSScriptRoot 'service.json')
)
$ErrorActionPreference = 'Stop'
$settings = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$state = Split-Path -Parent $Config
$pidPath = Join-Path $state 'server.pid'
$owned = $null
if (Test-Path -LiteralPath $pidPath) {
    $savedPid = [int](Get-Content -LiteralPath $pidPath -Raw)
    $candidate = Get-Process -Id $savedPid -ErrorAction SilentlyContinue
    if ($candidate -and $candidate.Path -eq $settings.runtimeExe) { $owned = $candidate }
}
if ($Action -eq 'stop') {
    if ($owned) {
        $killer = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\taskkill.exe') `
            -ArgumentList @('/PID', [string]$owned.Id, '/T', '/F') `
            -WindowStyle Hidden -Wait -PassThru
        if ($killer.ExitCode -ne 0) { throw 'Could not stop the owned embedding process tree.' }
    }
    Remove-Item -LiteralPath $pidPath -ErrorAction SilentlyContinue
    Write-Output 'Embedding service stopped.'
    exit
}
if ($Action -eq 'status') {
    Write-Output $(if ($owned) { 'Embedding service running.' } else { 'Embedding service stopped.' })
    exit
}
if ($owned) { Write-Output 'Embedding service already running.'; exit }
# One worker at a time; idle models release their GPU allocations. No prompt logs.
$serverArgs = @(
    '--host', '127.0.0.1', '--port', [string]$settings.port,
    '--models-dir', ('"{0}"' -f $settings.modelsDirectory), '--models-max', '1',
    '--embedding', '--pooling', 'last', '--parallel', '1',
    '--ctx-size', '8192', '--batch-size', '8192', '--ubatch-size', '512',
    '--sleep-idle-seconds', [string]$settings.idleSeconds,
    '--api-key-file', ('"{0}"' -f $settings.apiKeyFile), '--no-webui', '--log-disable'
)
$process = Start-Process -FilePath $settings.runtimeExe -ArgumentList $serverArgs `
    -WorkingDirectory (Split-Path -Parent $settings.runtimeExe) -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $state 'server.stdout.log') `
    -RedirectStandardError (Join-Path $state 'server.stderr.log') -PassThru
Set-Content -LiteralPath $pidPath -Value $process.Id
Write-Output ('Embedding service started on localhost:{0}.' -f $settings.port)
