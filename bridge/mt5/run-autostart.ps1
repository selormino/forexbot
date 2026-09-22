param(
  [Parameter(Mandatory=$false)][string]$BridgeDir = "",
  [Parameter(Mandatory=$false)][string]$PythonExe = "",
  [Parameter(Mandatory=$false)][string]$Mt5Path = "",
  [Parameter(Mandatory=$false)][string]$BindAddress = "127.0.0.1",
  [Parameter(Mandatory=$false)][int]$Port = 8765,
  [Parameter(Mandatory=$false)][int]$Mt5StartupWaitSec = 90,
  [Parameter(Mandatory=$false)][int]$RestartDelaySec = 5
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($BridgeDir)) {
  $BridgeDir = $PSScriptRoot
}
if ([string]::IsNullOrWhiteSpace($BridgeDir)) {
  $BridgeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrWhiteSpace($BridgeDir)) {
  throw "Could not determine the bridge folder. Re-run with -BridgeDir 'C:\forexbot\bridge\mt5'."
}
$BridgeDir = (Resolve-Path $BridgeDir).Path
$LogDir = Join-Path $BridgeDir "logs"
$LogFile = Join-Path $LogDir "autostart.log"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-BridgeLog {
  param([string]$Message)
  $line = "$(Get-Date -Format o) $Message"
  $line | Tee-Object -FilePath $LogFile -Append
}

function Find-Python {
  if ($PythonExe -and (Test-Path $PythonExe)) { return (Resolve-Path $PythonExe).Path }
  foreach ($name in @("python.exe","py.exe")) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  throw "Python was not found. Pass -PythonExe with the full path to python.exe."
}

function Find-Mt5 {
  if ($Mt5Path -and (Test-Path $Mt5Path)) { return (Resolve-Path $Mt5Path).Path }
  $roots = @(
    $env:ProgramFiles,
    [Environment]::GetEnvironmentVariable("ProgramFiles(x86)"),
    (Join-Path $env:LOCALAPPDATA "Programs")
  ) | Where-Object { $_ -and (Test-Path $_) }
  foreach ($root in $roots) {
    $candidate = Get-ChildItem -Path $root -Filter "terminal64.exe" -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($candidate) { return $candidate.FullName }
  }
  throw "MetaTrader 5 terminal64.exe was not found. Pass -Mt5Path with the full XM MT5 terminal path."
}

function Ensure-Mt5Running {
  param([string]$Terminal)
  $running = Get-Process -Name "terminal64" -ErrorAction SilentlyContinue
  if (-not $running) {
    Write-BridgeLog "Starting MetaTrader 5: $Terminal"
    Start-Process -FilePath $Terminal -WorkingDirectory (Split-Path $Terminal -Parent) | Out-Null
  } else {
    Write-BridgeLog "MetaTrader 5 is already running."
  }

  $deadline = (Get-Date).AddSeconds($Mt5StartupWaitSec)
  do {
    Start-Sleep -Seconds 2
    $running = Get-Process -Name "terminal64" -ErrorAction SilentlyContinue
    if ($running) {
      Write-BridgeLog "MetaTrader 5 process is available."
      return
    }
  } while ((Get-Date) -lt $deadline)

  throw "MetaTrader 5 did not start within $Mt5StartupWaitSec seconds."
}

$envFile = Join-Path $BridgeDir ".env"
if (-not (Test-Path $envFile)) {
  throw "Missing $envFile. Create bridge/mt5/.env before installing autostart."
}

$PythonExe = Find-Python
$Mt5Path = Find-Mt5
Write-BridgeLog "ForexBot MT5 supervisor starting. BridgeDir=$BridgeDir Python=$PythonExe MT5=$Mt5Path"
Ensure-Mt5Running -Terminal $Mt5Path
Set-Location $BridgeDir

while ($true) {
  try {
    Write-BridgeLog ("Starting FastAPI bridge on " + $BindAddress + ":" + $Port)
    & $PythonExe -m uvicorn main:app --host $BindAddress --port $Port 2>&1 | Tee-Object -FilePath $LogFile -Append
    $exitCode = $LASTEXITCODE
    Write-BridgeLog "Bridge exited with code $exitCode. Restarting in $RestartDelaySec seconds."
  } catch {
    Write-BridgeLog "Bridge process failed: $($_.Exception.Message). Restarting in $RestartDelaySec seconds."
  }
  Start-Sleep -Seconds $RestartDelaySec
  try { Ensure-Mt5Running -Terminal $Mt5Path } catch { Write-BridgeLog $_.Exception.Message }
}
