$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$platformRoot = Join-Path $repoRoot "nexdrive-platform"
$landingRoot = Join-Path $repoRoot "nexdrive-landing"

$targets = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'node.exe' -and (
    $_.CommandLine -like "*$platformRoot*" -or
    $_.CommandLine -like "*$landingRoot*"
  )
}

$ids = $targets | Select-Object -ExpandProperty ProcessId -Unique

if (-not $ids) {
  Write-Host "No NexDrive local dev node processes found."
  exit 0
}

Stop-Process -Id $ids -Force
Write-Host "Stopped NexDrive local processes: $($ids -join ', ')"
