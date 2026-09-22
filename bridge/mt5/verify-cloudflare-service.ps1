param(
  [Parameter(Mandatory=$false)][string]$BridgeDir = "",
  [Parameter(Mandatory=$false)][string]$PublicHostname = ""
)

$ErrorActionPreference = "Continue"

if ([string]::IsNullOrWhiteSpace($BridgeDir)) {
  $BridgeDir = $PSScriptRoot
}
if ([string]::IsNullOrWhiteSpace($BridgeDir)) {
  $BridgeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$BridgeDir = (Resolve-Path $BridgeDir).Path
$EnvFile = Join-Path $BridgeDir ".env"
$HostnameFile = Join-Path $BridgeDir "cloudflare-hostname.txt"

function Read-EnvValue {
  param([string]$Path,[string]$Name)
  if (-not (Test-Path $Path)) { return $null }
  $line = Get-Content $Path | Where-Object {
    $_ -match "^\s*$([regex]::Escape($Name))\s*="
  } | Select-Object -Last 1
  if (-not $line) { return $null }
  return (($line -split "=",2)[1]).Trim().Trim('"').Trim("'")
}

if ([string]::IsNullOrWhiteSpace($PublicHostname) -and (Test-Path $HostnameFile)) {
  $PublicHostname = (Get-Content $HostnameFile -Raw).Trim()
}

Write-Host "ForexBot Cloudflare Tunnel verification"
Write-Host "----------------------------------------"

$svc = Get-Service -Name "cloudflared" -ErrorAction SilentlyContinue
if ($svc) {
  Write-Host "[OK] cloudflared Windows service exists. Status=$($svc.Status)"
  $startMode = (Get-CimInstance Win32_Service -Filter "Name='cloudflared'" -ErrorAction SilentlyContinue).StartMode
  if ($startMode) { Write-Host "     Startup=$startMode" }
} else {
  Write-Host "[FAIL] cloudflared Windows service was not found."
}

$listener = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
if ($listener) { Write-Host "[OK] Local MT5 bridge is listening on 127.0.0.1:8765." }
else { Write-Host "[WARN] Local MT5 bridge is not listening on port 8765." }

$token = Read-EnvValue -Path $EnvFile -Name "BRIDGE_TOKEN"
if ($token) {
  try {
    $local = Invoke-RestMethod -Uri "http://127.0.0.1:8765/health" -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 10
    Write-Host "[OK] Local /health succeeded. Mode=$($local.mode), accountConnected=$($local.accountConnected), tradeAllowed=$($local.tradeAllowed)"
  } catch {
    Write-Host "[WARN] Local /health failed: $($_.Exception.Message)"
  }
} else {
  Write-Host "[WARN] BRIDGE_TOKEN was not found in the bridge .env."
}

if ([string]::IsNullOrWhiteSpace($PublicHostname)) {
  Write-Host "[WARN] Stable public hostname is unknown. Pass -PublicHostname or run the installer first."
  exit 0
}

try {
  $dns = Resolve-DnsName $PublicHostname -ErrorAction Stop
  Write-Host "[OK] DNS resolves for $PublicHostname."
} catch {
  Write-Host "[WARN] DNS does not resolve for $PublicHostname yet: $($_.Exception.Message)"
}

if ($token) {
  try {
    $public = Invoke-RestMethod -Uri ("https://" + $PublicHostname + "/health") -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 20
    Write-Host "[OK] Public tunnel /health succeeded. Mode=$($public.mode), accountConnected=$($public.accountConnected), tradeAllowed=$($public.tradeAllowed)"
  } catch {
    Write-Host "[WARN] Public tunnel /health failed: $($_.Exception.Message)"
  }
}

Write-Host ""
Write-Host "Stable bridge URL for Railway:"
Write-Host ("https://" + $PublicHostname)
