param(
  [Parameter(Mandatory=$false)][string]$BridgeDir = "",
  [Parameter(Mandatory=$false)][string]$CloudflaredExe = ""
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($BridgeDir)) { $BridgeDir = $PSScriptRoot }
if ([string]::IsNullOrWhiteSpace($BridgeDir)) { $BridgeDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$BridgeDir = (Resolve-Path $BridgeDir).Path

if (-not $CloudflaredExe) {
  foreach ($name in @("cloudflared.exe","cloudflared")) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { $CloudflaredExe = $cmd.Source; break }
  }
}
if (-not $CloudflaredExe) { throw "cloudflared was not found." }

try { Stop-Service -Name "cloudflared" -Force -ErrorAction SilentlyContinue } catch {}
& $CloudflaredExe service uninstall | Out-Host
if ($LASTEXITCODE -ne 0) { throw "cloudflared service uninstall failed with exit code $LASTEXITCODE." }

$hostnameFile = Join-Path $BridgeDir "cloudflare-hostname.txt"
if (Test-Path $hostnameFile) { Remove-Item $hostnameFile -Force }

Write-Host "Cloudflare Windows service removed. Cloudflare dashboard tunnel/DNS configuration was not deleted."
