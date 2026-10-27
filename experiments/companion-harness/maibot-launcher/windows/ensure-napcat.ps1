param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$launcher = Join-Path $InstallRoot 'start-bot-background.vbs'
$executable = Join-Path $InstallRoot 'shell\NapCatWinBootMain.exe'

function Find-Launcher {
    Get-CimInstance Win32_Process -Filter "Name='NapCatWinBootMain.exe'" |
        Where-Object { $_.ExecutablePath -eq $executable } |
        Select-Object -First 1
}

$process = Find-Launcher
$started = $false
if (-not $process -and -not $CheckOnly) {
    if (-not (Test-Path -LiteralPath $launcher) -or -not (Test-Path -LiteralPath $executable)) {
        throw 'NapCat installation or background launcher is missing.'
    }
    Start-Process -FilePath 'wscript.exe' -ArgumentList @('//B', '//Nologo', ('"{0}"' -f $launcher)) `
        -WorkingDirectory $InstallRoot -WindowStyle Hidden | Out-Null
    $started = $true
    $deadline = [DateTime]::UtcNow.AddSeconds(12)
    do {
        Start-Sleep -Milliseconds 400
        $process = Find-Launcher
    } while (-not $process -and [DateTime]::UtcNow -lt $deadline)
    if (-not $process) { throw 'NapCat background process did not start.' }
}
@{ running = [bool]$process; started = $started } | ConvertTo-Json -Compress
