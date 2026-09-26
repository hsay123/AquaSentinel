<#
AquaSentinel setup verifier (Windows).

    .\setup.ps1            verify only (safe to re-run any time)
    .\setup.ps1 -Setup     also create the venv, install deps and scaffold .env

Prints a PASS/FAIL summary and exits non-zero if anything is missing.
See SETUP.md for the narrative version.
#>

param([switch]$Setup)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$script:Failures = 0
$script:Warnings = 0

function Step($msg) { Write-Host "`n$msg" -ForegroundColor Cyan }
function Pass($msg) { Write-Host "  PASS  $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "  FAIL  $msg" -ForegroundColor Red; $script:Failures++ }
function Warn($msg) { Write-Host "  WARN  $msg" -ForegroundColor Yellow; $script:Warnings++ }

$Py = "venv\Scripts\python.exe"

function Get-EnvValue($name) {
    if (-not (Test-Path ".env")) { return "" }
    $line = Select-String -Path ".env" -Pattern "^\s*$name\s*=" -ErrorAction SilentlyContinue | Select-Object -Last 1
    if (-not $line) { return "" }
    return ($line.Line -split "=", 2)[1].Trim()
}

# --------------------------------------------------------------------------- #
if ($Setup) {
    Step "Bootstrapping"
    if (-not (Test-Path "venv")) {
        python -m venv venv
        if ($?) { Pass "created venv" } else { Fail "could not create venv (is python installed?)" }
    } else { Pass "venv already present" }

    if (Test-Path $Py) {
        & $Py -m pip install -q -r backend\requirements.txt
        if ($?) { Pass "installed backend requirements" } else { Fail "pip install failed" }
    }
    if (-not (Test-Path "frontend\node_modules")) {
        Push-Location frontend; npm install | Out-Null; Pop-Location
        if ($?) { Pass "installed frontend dependencies" } else { Fail "npm install failed" }
    } else { Pass "frontend\node_modules already present" }

    if (-not (Test-Path ".env")) {
        Copy-Item .env.example .env
        Pass "created .env from .env.example (fill in the GEE_* values)"
    }
}

# --------------------------------------------------------------------------- #
Step "Python environment"
if (Test-Path $Py) {
    $ver = & $Py --version 2>&1
    Pass "venv present ($ver)"
    & $Py -c "import ee, fastapi, pandas, pyarrow" 2>$null
    if ($LASTEXITCODE -eq 0) {
        Pass "backend dependencies importable (earthengine-api, fastapi, pandas, pyarrow)"
    } else {
        Fail "backend dependencies missing - run: pip install -r backend\requirements.txt"
    }
} else {
    Fail "no venv at .\venv - run: python -m venv venv"
}

Step "Frontend dependencies"
if (Test-Path "frontend\node_modules") {
    Pass "frontend\node_modules present"
} else {
    Fail "frontend\node_modules missing - run: cd frontend; npm install"
}

# --------------------------------------------------------------------------- #
Step "Configuration"
if (Test-Path ".env") {
    Pass ".env present"
    $saEmail = Get-EnvValue "GEE_SERVICE_ACCOUNT_EMAIL"
    $saPath  = Get-EnvValue "GEE_SERVICE_ACCOUNT_KEY_PATH"
    $project = Get-EnvValue "GEE_PROJECT_ID"
    $credJson = Get-EnvValue "EE_CREDENTIALS_JSON"

    if ($saEmail -and $saPath) {
        Pass "service account configured ($saEmail)"
        if ($saEmail -notlike "*.gserviceaccount.com") {
            Fail "GEE_SERVICE_ACCOUNT_EMAIL is not a *@*.gserviceaccount.com address"
        }
        $key = $saPath -replace "/", "\"
        if (-not [System.IO.Path]::IsPathRooted($key)) { $key = Join-Path $PSScriptRoot $key }
        if (Test-Path $key) {
            Pass "key file present at $saPath"
            $raw = Get-Content $key -Raw
            if ($raw -match '"type"\s*:\s*"service_account"') {
                Pass "key file is a service account key"
            } else {
                Fail "key file is not a service account key (expected `"type`": `"service_account`")"
            }
            if ($raw -match '"client_email"\s*:\s*"([^"]+)"' -and $Matches[1] -ne $saEmail) {
                Fail "key file belongs to '$($Matches[1])' but .env says '$saEmail'"
            }
        } else {
            Fail "key file not found at $saPath - request it from the repo owner (SETUP.md step 5)"
        }
    } elseif ($credJson) {
        Warn "using EE_CREDENTIALS_JSON (single-host deploy path) instead of a service account"
    } else {
        Fail "no GEE credentials configured in .env"
        Write-Host "        set GEE_SERVICE_ACCOUNT_EMAIL and GEE_SERVICE_ACCOUNT_KEY_PATH" -ForegroundColor DarkGray
        Write-Host "        (or run 'earthengine authenticate' for solo local dev)" -ForegroundColor DarkGray
    }

    if ($project) { Pass "GEE_PROJECT_ID = $project" } else { Warn "GEE_PROJECT_ID not set - using the built-in default" }
    if (Get-EnvValue "GROQ_API_KEY") { Pass "GROQ_API_KEY set (LLM polish enabled)" } else { Warn "GROQ_API_KEY not set - alert explanations use templates" }
} else {
    Fail ".env missing - run: Copy-Item .env.example .env"
}

# --------------------------------------------------------------------------- #
Step "Git hygiene"
if (Test-Path ".git") {
    git check-ignore -q .env 2>$null
    if ($LASTEXITCODE -eq 0) { Pass ".env is gitignored" } else { Fail ".env is NOT gitignored" }
    git check-ignore -q secrets/gee-key.json 2>$null
    if ($LASTEXITCODE -eq 0) { Pass "secrets/ is gitignored" } else { Fail "secrets/gee-key.json is NOT gitignored" }
    $tracked = git ls-files | Select-String -Pattern '(\.env$|secret|key.*\.json$|service.*account.*\.json$)' | Where-Object { $_ -notmatch '\.env\.example$' }
    if (-not $tracked) { Pass "no credential files are tracked in git" } else { Fail "credential-looking files are TRACKED in git: $tracked" }
} else {
    Warn "not a git repository - skipped .gitignore verification"
}

# --------------------------------------------------------------------------- #
Step "Earth Engine live check"
if (Test-Path $Py) {
    & $Py -c "import ee, fastapi" 2>$null
    if ($LASTEXITCODE -eq 0) {
        $out = & $Py -c "import backend.gee_client as g; r=g.diagnose(); f=lambda v: ' '.join((v or '').split()); print('STATUS='+f(r.get('gee_status'))); print('MESSAGE='+f(r.get('gee_message'))); print('FIX='+f(r.get('gee_fix')))" 2>&1
        $status = (($out | Select-String '^STATUS=') -replace '^STATUS=', '') -join ""
        $msg    = (($out | Select-String '^MESSAGE=') -replace '^MESSAGE=', '') -join ""
        $fix    = (($out | Select-String '^FIX=') -replace '^FIX=', '') -join ""
        if ($status -eq "ok") {
            Pass "GEE reachable - $msg"
        } elseif (-not $status) {
            Warn "health check produced no output (is the repo root the current directory?)"
        } else {
            Fail "GEE status: $status"
            Write-Host "        $msg" -ForegroundColor DarkGray
            if ($fix) { Write-Host "        fix: $fix" -ForegroundColor DarkGray }
        }
    } else {
        Warn "backend dependencies not importable - skipped the live GEE check"
    }
} else {
    Warn "no venv - skipped the live GEE check"
}

# --------------------------------------------------------------------------- #
Step "Summary"
if ($script:Failures -eq 0) {
    Write-Host "  ALL CHECKS PASSED" -ForegroundColor Green
    if ($script:Warnings -gt 0) { Write-Host "  ($($script:Warnings) warning(s) - non-blocking)" -ForegroundColor Yellow }
    Write-Host "  Next: start the backend and frontend (SETUP.md step 7)." -ForegroundColor DarkGray
    exit 0
} else {
    Write-Host "  $($script:Failures) CHECK(S) FAILED - see the FAIL lines above and SETUP.md." -ForegroundColor Red
    exit 1
}
