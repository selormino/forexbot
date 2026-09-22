param(
  [Parameter(Mandatory=$false)][string]$BridgeDir = "",
  [Parameter(Mandatory=$false)][string]$TaskName = "ForexBot MT5 Bridge",
  [Parameter(Mandatory=$false)][int]$Port = 8765
)

$ErrorActionPreference = "Continue"
if ([string]::IsNullOrWhiteSpace($BridgeDir)) {
  $BridgeDir = $PSScriptRoot
}
if ([string]::IsNullOrWhiteSpace($BridgeDir)) {
  $BridgeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrWhiteSpace($BridgeDir)) {
  Write-Host "[FAIL] Could not determine bridge folder. Re-run with -BridgeDir 'C:\forexbot\bridge\mt5'."
  exit 2
}
$BridgeDir = (Resolve-Path $BridgeDir).Path
$EnvFile = Join-Path $BridgeDir ".env"
$LogFile = Join-Path $BridgeDir "logs\autostart.log"

function Read-EnvValue {
  param([string]$Path,[string]$Name)
  if (-not (Test-Path $Path)) { return $null }
  $line = Get-Content $Path | Where-Object {
    $_ -match "^\s*$([regex]::Escape($Name))\s*="
  } | Select-Object -Last 1
  if (-not $line) { return $null }
  return (($line -split "=",2)[1]).Trim().Trim('"').Trim("'")
}

Write-Host "ForexBot AWS/MT5 autostart verification"
Write-Host "---------------------------------------"

$task = & schtasks.exe /Query /TN $TaskName /FO LIST /V 2>$null
if ($LASTEXITCODE -eq 0) {
  Write-Host "[OK] Scheduled task exists: $TaskName"
  $task | Select-String "Status:|Last Run Time:|Last Result:|Next Run Time:" | ForEach-Object { Write-Host "     $($_.Line.Trim())" }
} else {
  Write-Host "[FAIL] Scheduled task not found: $TaskName"
}

$mt5 = Get-Process -Name "terminal64" -ErrorAction SilentlyContinue
if ($mt5) { Write-Host "[OK] MetaTrader 5 is running (PID $($mt5[0].Id))." }
else { Write-Host "[WARN] MetaTrader 5 is not running in this Windows session." }

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) { Write-Host "[OK] Bridge is listening on local port $Port." }
else { Write-Host "[WARN] Nothing is listening on port $Port." }

$token = Read-EnvValue -Path $EnvFile -Name "BRIDGE_TOKEN"
if ($token) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 10
    Write-Host "[OK] Bridge /health succeeded. Mode=$($health.mode), accountConnected=$($health.accountConnected), tradeAllowed=$($health.tradeAllowed)"
  } catch {
    Write-Host "[WARN] Bridge /health did not succeed: $($_.Exception.Message)"
  }
} else {
  Write-Host "[WARN] BRIDGE_TOKEN was not found in .env, so authenticated /health was not checked."
}

if (Test-Path $LogFile) {
  Write-Host ""
  Write-Host "Recent supervisor log:"
  Get-Content $LogFile -Tail 12 | ForEach-Object { Write-Host "  $_" }
}
