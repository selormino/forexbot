param(
  [Parameter(Mandatory=$false)][string]$BridgeDir = "",
  [Parameter(Mandatory=$false)][string]$PythonExe = "",
  [Parameter(Mandatory=$false)][string]$Mt5Path = "",
  [Parameter(Mandatory=$false)][string]$TaskName = "ForexBot MT5 Bridge",
  [Parameter(Mandatory=$false)][string]$BindAddress = "127.0.0.1",
  [Parameter(Mandatory=$false)][int]$Port = 8765,
  [switch]$StartNow
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

function Resolve-Python {
  param([string]$Requested)
  if ($Requested -and (Test-Path $Requested)) { return (Resolve-Path $Requested).Path }
  $cmd = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
  if ($launcher) { return $launcher.Source }
  throw "Python was not found. Re-run with -PythonExe 'C:\path\to\python.exe'."
}

function Resolve-Mt5 {
  param([string]$Requested)
  if ($Requested -and (Test-Path $Requested)) { return (Resolve-Path $Requested).Path }
  $roots = @(
    $env:ProgramFiles,
    [Environment]::GetEnvironmentVariable("ProgramFiles(x86)"),
    (Join-Path $env:LOCALAPPDATA "Programs")
  ) | Where-Object { $_ -and (Test-Path $_) }
  foreach ($root in $roots) {
    $candidate = Get-ChildItem -Path $root -Filter "terminal64.exe" -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($candidate) { return $candidate.FullName }
  }
  throw "XM MetaTrader 5 was not found. Re-run with -Mt5Path 'C:\...\terminal64.exe'."
}

$BridgeDir = (Resolve-Path $BridgeDir).Path
$Runner = Join-Path $BridgeDir "run-autostart.ps1"
$EnvFile = Join-Path $BridgeDir ".env"
$PythonExe = Resolve-Python $PythonExe
$Mt5Path = Resolve-Mt5 $Mt5Path

if (-not (Test-Path $Runner)) { throw "Missing launcher: $Runner" }
if (-not (Test-Path $EnvFile)) { throw "Missing bridge .env: $EnvFile" }

$quotedRunner = '"' + $Runner + '"'
$quotedBridge = '"' + $BridgeDir + '"'
$quotedPython = '"' + $PythonExe + '"'
$quotedMt5 = '"' + $Mt5Path + '"'
$taskArguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $quotedRunner -BridgeDir $quotedBridge -PythonExe $quotedPython -Mt5Path $quotedMt5 -BindAddress $BindAddress -Port $Port"
$currentUser = "$env:USERDOMAIN\$env:USERNAME"

Write-Host ""
Write-Host "Installing scheduled task: $TaskName"
Write-Host "Windows user: $currentUser"
Write-Host "Bridge folder: $BridgeDir"
Write-Host "Python: $PythonExe"
Write-Host "XM MT5: $Mt5Path"
Write-Host ""
Write-Host "The task runs at Windows logon. It does NOT enable Windows auto-logon."

Import-Module ScheduledTasks -ErrorAction Stop
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $taskArguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

if ($StartNow) {
  Write-Host "Starting scheduled task now..."
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 3
}

Write-Host ""
Write-Host "Installed successfully."
Write-Host "After the next Windows login, ForexBot will:"
Write-Host "  1. start XM MetaTrader 5 if it is not running"
Write-Host "  2. wait for the terminal process"
Write-Host "  3. start the FastAPI MT5 bridge"
Write-Host "  4. restart the bridge automatically if it exits"
Write-Host ""
Write-Host "Verify with: powershell -ExecutionPolicy Bypass -File .\verify-autostart.ps1"
