<# 
AquaSentinel Demo Startup Script
Run from project root: .\start_demo.ps1
#>

param(
    [switch]$SkipPrecompute,
    [switch]$LiveMode,
    [switch]$Setup
)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  AquaSentinel Demo Startup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$Py = "venv\Scripts\python.exe"

# Check prerequisites
Write-Host "Checking prerequisites..." -ForegroundColor Yellow

if (-not (Test-Path $Py)) {
    Write-Host "Creating Python venv..." -ForegroundColor Yellow
    python -m venv venv
    & $Py -m pip install -q --upgrade pip
    & $Py -m pip install -q -r backend\requirements.txt
}
Write-Host "Python env: $(& $Py --version 2>&1)"

if (-not (Test-Path "frontend\node_modules")) {
    Write-Host "Installing frontend dependencies..." -ForegroundColor Yellow
    Push-Location frontend
    npm install
    Pop-Location
}

# Check GEE auth — same diagnosis the backend uses, so this message matches
# what the UI header will show.
Write-Host ""
Write-Host "Checking GEE authentication..." -ForegroundColor Yellow
$geeOut = & $Py -c "import backend.gee_client as g; r=g.diagnose(); f=lambda v: ' '.join((v or '').split()); print('STATUS='+f(r.get('gee_status'))); print('MESSAGE='+f(r.get('gee_message'))); print('FIX='+f(r.get('gee_fix')))" 2>$null
$geeStatus = (($geeOut | Select-String '^STATUS=')  -replace '^STATUS=', '') -join ""
$geeMsg    = (($geeOut | Select-String '^MESSAGE=') -replace '^MESSAGE=', '') -join ""
$geeFix    = (($geeOut | Select-String '^FIX=')    -replace '^FIX=', '') -join ""

if ($geeStatus -eq "ok") {
    Write-Host "GEE authenticated: $geeMsg" -ForegroundColor Green
} else {
    Write-Warning "GEE unavailable (status: $geeStatus)"
    Write-Host "  reason: $geeMsg" -ForegroundColor DarkGray
    if ($geeFix) { Write-Host "  fix:    $geeFix" -ForegroundColor DarkGray }
    Write-Host "  See SETUP.md. Continuing anyway so the UI can show the specific reason." -ForegroundColor DarkGray
}

# Run precompute if needed
if (-not $SkipPrecompute) {
    if (-not (Test-Path "data\timeseries") -or -not (Get-ChildItem "data\timeseries" -ErrorAction SilentlyContinue)) {
        Write-Host "Running precompute (fetches real Sentinel-2 data from GEE)..." -ForegroundColor Yellow
        Write-Host "This may take 5-15 minutes depending on GEE quota..." -ForegroundColor Yellow
        & $Py -m backend.scripts.precompute
        if ($LASTEXITCODE -ne 0) {
            Write-Error "Precompute failed. Check GEE quota and authentication."
            exit 1
        }
    } else {
        Write-Host "Cache found, skipping precompute. Use -SkipPrecompute to skip this check." -ForegroundColor Green
    }
}

# Start backend from the repo root so `backend.*` imports resolve (running
# uvicorn from backend/ used to fail with ModuleNotFoundError).
Write-Host ""
Write-Host "Starting backend on http://localhost:8000..." -ForegroundColor Green
$backend = Start-Process -FilePath $Py `
    -ArgumentList "-m", "uvicorn", "backend.main:app", "--reload", "--port", "8000" `
    -WorkingDirectory $PSScriptRoot `
    -PassThru

# Wait for the backend to answer /health before starting the frontend, so the
# "Failed to load waterbodies" banner never flashes on a cold start.
Start-Sleep 3
for ($i = 0; $i -lt 20; $i++) {
    try {
        Invoke-WebRequest -Uri "http://localhost:8000/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
        break
    } catch { Start-Sleep 1 }
}

# Start frontend
Write-Host "Starting frontend on http://localhost:5173..." -ForegroundColor Green
$frontend = Start-Process -FilePath "npm" `
    -ArgumentList "run", "dev" `
    -WorkingDirectory "frontend" `
    -PassThru

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Demo Ready!" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Frontend: http://localhost:5173" -ForegroundColor Cyan
Write-Host "Backend API: http://localhost:8000" -ForegroundColor Cyan
Write-Host "API Docs: http://localhost:8000/docs" -ForegroundColor Cyan
Write-Host ""
Write-Host "Press Ctrl+C to stop both servers" -ForegroundColor Yellow

# Wait for user to stop
try {
    Wait-Process -Id $backend.Id, $frontend.Id -ErrorAction SilentlyContinue
} catch {
    # Ignore
}

# Cleanup on exit
Write-Host "Stopping servers..." -ForegroundColor Yellow
Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue
Stop-Process -Id $frontend.Id -Force -ErrorAction SilentlyContinue
Write-Host "Done." -ForegroundColor Green