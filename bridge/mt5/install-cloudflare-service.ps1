param(
  [Parameter(Mandatory=$false)][string]$BridgeDir = "",
  [Parameter(Mandatory=$true)][string]$PublicHostname,
  [Parameter(Mandatory=$false)][string]$CloudflaredExe = "",
  [Parameter(Mandatory=$false)][securestring]$TunnelToken,
  [switch]$ReplaceExistingService
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($BridgeDir)) {
  $BridgeDir = $PSScriptRoot
}
if ([string]::IsNullOrWhiteSpace($BridgeDir)) {
  $BridgeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$BridgeDir = (Resolve-Path $BridgeDir).Path

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run PowerShell as Administrator and retry."
  }
}

function Resolve-Cloudflared {
  param([string]$Requested)
  if ($Requested -and (Test-Path $Requested)) { return (Resolve-Path $Requested).Path }
  foreach ($name in @("cloudflared.exe","cloudflared")) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
  }
  throw "cloudflared was not found. Install cloudflared first, or pass -CloudflaredExe with its full path."
}

function Read-EnvValue {
  param([string]$Path,[string]$Name)
  if (-not (Test-Path $Path)) { return $null }
  $line = Get-Content $Path | Where-Object {
    $_ -match "^\s*$([regex]::Escape($Name))\s*="
  } | Select-Object -Last 1
  if (-not $line) { return $null }
  return (($line -split "=",2)[1]).Trim().Trim('"').Trim("'")
}

Assert-Administrator
$CloudflaredExe = Resolve-Cloudflared $CloudflaredExe
$EnvFile = Join-Path $BridgeDir ".env"
if (-not (Test-Path $EnvFile)) {
  throw "Missing bridge .env at $EnvFile."
}

$hostname = $PublicHostname.Trim().ToLowerInvariant()
if ($hostname -notmatch "^[a-z0-9][a-z0-9.-]+[a-z0-9]$") {
  throw "PublicHostname does not look like a valid DNS hostname."
}

$existing = Get-Service -Name "cloudflared" -ErrorAction SilentlyContinue
if ($existing -and -not $ReplaceExistingService) {
  throw "A cloudflared Windows service already exists. Re-run with -ReplaceExistingService only if you intend to replace it."
}

if ($existing -and $ReplaceExistingService) {
  Write-Host "Removing the existing cloudflared Windows service..."
  try { Stop-Service -Name "cloudflared" -Force -ErrorAction SilentlyContinue } catch {}
  & $CloudflaredExe service uninstall | Out-Host
  Start-Sleep -Seconds 2
}

if (-not $TunnelToken) {
  Write-Host ""
  Write-Host "Paste the named-tunnel token from Cloudflare Zero Trust."
  Write-Host "The token is read securely and is not written to the ForexBot repo or supervisor logs."
  $TunnelToken = Read-Host "Tunnel token" -AsSecureString
}

$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($TunnelToken)
try {
  $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if ([string]::IsNullOrWhiteSpace($plainToken)) { throw "Tunnel token was empty." }

  Write-Host ""
  Write-Host "Installing Cloudflare Tunnel as a Windows service..."
  & $CloudflaredExe service install $plainToken | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "cloudflared service install failed with exit code $LASTEXITCODE."
  }
} finally {
  if ($bstr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
  $plainToken = $null
}

Set-Service -Name "cloudflared" -StartupType Automatic
Start-Service -Name "cloudflared"
Start-Sleep -Seconds 4

$hostnameFile = Join-Path $BridgeDir "cloudflare-hostname.txt"
Set-Content -Path $hostnameFile -Value $hostname -Encoding ASCII

Write-Host ""
Write-Host "Cloudflare service installed."
Write-Host "Stable hostname: https://$hostname"
Write-Host "Origin expected in Cloudflare: http://127.0.0.1:8765"
Write-Host ""
Write-Host "Checking local bridge before public verification..."
$token = Read-EnvValue -Path $EnvFile -Name "BRIDGE_TOKEN"
if ($token) {
  try {
    $local = Invoke-RestMethod -Uri "http://127.0.0.1:8765/health" -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 10
    Write-Host "[OK] Local bridge: mode=$($local.mode), accountConnected=$($local.accountConnected), tradeAllowed=$($local.tradeAllowed)"
  } catch {
    Write-Host "[WARN] Local bridge health did not succeed yet: $($_.Exception.Message)"
  }
}

Write-Host ""
Write-Host "Run the final verification with:"
Write-Host "  powershell -ExecutionPolicy Bypass -File .\verify-cloudflare-service.ps1 -BridgeDir `"$BridgeDir`""
