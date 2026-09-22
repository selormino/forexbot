param(
  [Parameter(Mandatory=$false)][string]$TaskName = "ForexBot MT5 Bridge"
)

$ErrorActionPreference = "Stop"
& schtasks.exe /Delete /TN $TaskName /F | Out-Host
if ($LASTEXITCODE -ne 0) {
  throw "Could not remove scheduled task '$TaskName'."
}
Write-Host "Removed scheduled task '$TaskName'. No .env files, MT5 files, or bridge code were deleted."
