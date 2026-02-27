param(
  [switch]$Install,
  [switch]$PlatformOnly,
  [int]$PlatformPort = 3000,
  [int]$LandingPort = 5173
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$PlatformPath = Join-Path $RepoRoot "nexdrive-platform"
$LandingPath = Join-Path $RepoRoot "nexdrive-landing"
$PlatformEnv = Join-Path $PlatformPath ".env.local"
$PlatformEnvExample = Join-Path $PlatformPath ".env.local.example"

function Ensure-Dependencies([string]$ProjectPath) {
  $nodeModulesPath = Join-Path $ProjectPath "node_modules"
  if ($Install -or -not (Test-Path $nodeModulesPath)) {
    Write-Host "Installing dependencies in $ProjectPath ..." -ForegroundColor Cyan
    npm install --prefix $ProjectPath
  }
}

function Test-PortInUse([int]$Port) {
  $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  return $null -ne $connections
}

if (-not (Test-Path $PlatformEnv) -and (Test-Path $PlatformEnvExample)) {
  Copy-Item $PlatformEnvExample $PlatformEnv
  Write-Host "Created nexdrive-platform/.env.local from .env.local.example" -ForegroundColor Yellow
}

if (Test-Path $PlatformEnv) {
  $envContent = Get-Content -Raw $PlatformEnv
  if ($envContent -notmatch "(?m)^NEXDRIVE_LOCAL_MODE=") {
    Add-Content -Path $PlatformEnv -Value "`r`nNEXDRIVE_LOCAL_MODE=true"
  }
}

if (Test-PortInUse $PlatformPort) {
  throw "Platform port $PlatformPort is already in use. Free it first or run with -PlatformPort <free-port>."
}
if (-not $PlatformOnly -and (Test-PortInUse $LandingPort)) {
  throw "Landing port $LandingPort is already in use. Free it first or run with -LandingPort <free-port>."
}

Ensure-Dependencies $PlatformPath
if (-not $PlatformOnly) {
  Ensure-Dependencies $LandingPath
}

$env:NEXDRIVE_LOCAL_MODE = "true"

Write-Host ""
Write-Host "Starting NexDrive local mode..." -ForegroundColor Green
Write-Host "Platform: http://localhost:$PlatformPort" -ForegroundColor Green
if (-not $PlatformOnly) {
  Write-Host "Landing:  http://localhost:$LandingPort" -ForegroundColor Green
}
Write-Host ""

$platformProc = Start-Process -FilePath "npm.cmd" -ArgumentList @("run", "dev", "--prefix", $PlatformPath) -PassThru -Environment @{
  PORT = "$PlatformPort"
  NEXDRIVE_LOCAL_MODE = "true"
}

$landingProc = $null
if (-not $PlatformOnly) {
  $landingProc = Start-Process -FilePath "npm.cmd" -ArgumentList @("run", "dev", "--prefix", $LandingPath) -PassThru -Environment @{
    PORT = "$LandingPort"
  }
}

Write-Host "Started platform PID: $($platformProc.Id)" -ForegroundColor DarkGray
if ($landingProc) {
  Write-Host "Started landing PID:  $($landingProc.Id)" -ForegroundColor DarkGray
}

$stopIds = @($platformProc.Id)
if ($landingProc) {
  $stopIds += $landingProc.Id
}

Write-Host ""
Write-Host "Health:   http://localhost:$PlatformPort/api/health" -ForegroundColor DarkGray
Write-Host "To stop:  Stop-Process -Id $($stopIds -join ',')" -ForegroundColor Yellow
