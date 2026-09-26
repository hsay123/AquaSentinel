#!/usr/bin/env bash
# AquaSentinel setup verifier.
#
#   ./setup.sh          verify only (safe to re-run any time)
#   ./setup.sh --setup  also create the venv, install deps and scaffold .env
#
# Prints a PASS/FAIL summary and exits non-zero if anything is missing, so you
# never have to dig through logs to find out whether this machine is ready.
# See SETUP.md for the narrative version.

set -uo pipefail
cd "$(dirname "$0")"

BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
FAILURES=0
WARNINGS=0

DO_SETUP=false
[ "${1:-}" = "--setup" ] && DO_SETUP=true

ok()   { printf '  %sPASS%s  %s\n' "$GREEN" "$OFF" "$1"; }
bad()  { printf '  %sFAIL%s  %s\n' "$RED" "$OFF" "$1"; FAILURES=$((FAILURES + 1)); }
warn() { printf '  %sWARN%s  %s\n' "$YELLOW" "$OFF" "$1"; WARNINGS=$((WARNINGS + 1)); }
step() { printf '\n%s%s%s\n' "$BOLD" "$1" "$OFF"; }

# --------------------------------------------------------------------------- #
if [ "$DO_SETUP" = true ]; then
  step "Bootstrapping"
  if [ ! -d venv ]; then
    python3 -m venv venv && ok "created venv" || bad "could not create venv (is python3 installed?)"
  else
    ok "venv already present"
  fi
  if [ -x venv/bin/python ]; then
    venv/bin/pip install -q -r backend/requirements.txt \
      && ok "installed backend requirements" \
      || bad "pip install -r backend/requirements.txt failed"
  fi
  if [ ! -d frontend/node_modules ]; then
    (cd frontend && npm install) >/dev/null 2>&1 \
      && ok "installed frontend dependencies" \
      || bad "npm install failed in frontend/"
  else
    ok "frontend/node_modules already present"
  fi
  if [ ! -f .env ]; then
    cp .env.example .env && ok "created .env from .env.example (fill in the GEE_* values)" \
      || bad "could not create .env"
  fi
fi

# --------------------------------------------------------------------------- #
step "Python environment"
if [ -x venv/bin/python ]; then
  ok "venv present ($(venv/bin/python --version 2>&1))"
  if venv/bin/python -c 'import ee, fastapi, pandas, pyarrow' 2>/dev/null; then
    ok "backend dependencies importable (earthengine-api, fastapi, pandas, pyarrow)"
  else
    bad "backend dependencies missing — run: pip install -r backend/requirements.txt"
  fi
else
  bad "no venv at ./venv — run: python3 -m venv venv && source venv/bin/activate"
  FAILURES=$((FAILURES + 1))
fi

step "Frontend dependencies"
if [ -d frontend/node_modules ]; then
  ok "frontend/node_modules present"
else
  bad "frontend/node_modules missing — run: cd frontend && npm install"
fi

# --------------------------------------------------------------------------- #
step "Configuration"

# Read .env without sourcing it (it may contain JSON with quotes/spaces).
envval() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\(.*\)$/\1/p" .env 2>/dev/null | tail -1 | sed 's/[[:space:]]*$//'; }

if [ -f .env ]; then
  ok ".env present"
  # Never echo a secret value back to the terminal.
  sa_email=$(envval GEE_SERVICE_ACCOUNT_EMAIL)
  sa_path=$(envval GEE_SERVICE_ACCOUNT_KEY_PATH)
  project=$(envval GEE_PROJECT_ID)
  creds_json=$(envval EE_CREDENTIALS_JSON)

  if [ -n "$sa_email" ] && [ -n "$sa_path" ]; then
    ok "service account configured ($sa_email)"
    case "$sa_email" in
      *.gserviceaccount.com) : ;;
      *) bad "GEE_SERVICE_ACCOUNT_EMAIL is not a *@*.gserviceaccount.com address" ;;
    esac
    case "$sa_path" in
      /*) key="$sa_path" ;;
      *)  key="$PWD/${sa_path#./}" ;;
    esac
    if [ -f "$key" ]; then
      ok "key file present at $sa_path"
      if grep -q '"type"[[:space:]]*:[[:space:]]*"service_account"' "$key" 2>/dev/null; then
        ok "key file is a service account key"
      else
        bad "key file is not a service account key (expected \"type\": \"service_account\")"
      fi
      key_email=$(sed -n 's/.*"client_email"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$key" 2>/dev/null | head -1)
      if [ -n "$key_email" ] && [ "$key_email" != "$sa_email" ]; then
        bad "key file belongs to '$key_email' but .env says '$sa_email'"
      elif [ -n "$key_email" ]; then
        ok "key file email matches .env"
      fi
    else
      bad "key file not found at $sa_path — request it from the repo owner (SETUP.md step 5)"
    fi
  elif [ -n "$creds_json" ]; then
    warn "using EE_CREDENTIALS_JSON (single-host deploy path) instead of a service account"
  else
    printf '  %sFAIL%s  no GEE credentials configured in .env\n' "$RED" "$OFF"
    printf '        %sset GEE_SERVICE_ACCOUNT_EMAIL and GEE_SERVICE_ACCOUNT_KEY_PATH%s\n' "$DIM" "$OFF"
    printf '        %s(or run `earthengine authenticate` for solo local dev)%s\n' "$DIM" "$OFF"
    FAILURES=$((FAILURES + 1))
  fi

  if [ -n "$project" ]; then
    ok "GEE_PROJECT_ID = $project"
  else
    warn "GEE_PROJECT_ID not set — falling back to the built-in default"
  fi

  if [ -n "$(envval GROQ_API_KEY)" ]; then
    ok "GROQ_API_KEY set (LLM polish enabled)"
  else
    warn "GROQ_API_KEY not set — alert explanations use templates (fully functional)"
  fi
else
  bad ".env missing — run: cp .env.example .env"
fi

# --------------------------------------------------------------------------- #
step "Git hygiene"
if git rev-parse --git-dir >/dev/null 2>&1; then
  if git check-ignore -q .env 2>/dev/null; then
    ok ".env is gitignored"
  else
    bad ".env is NOT gitignored — fix .gitignore before committing anything"
  fi
  if git check-ignore -q secrets/gee-key.json 2>/dev/null; then
    ok "secrets/ is gitignored"
  else
    bad "secrets/gee-key.json is NOT gitignored — fix .gitignore before committing anything"
  fi
  tracked=$(git ls-files | grep -Ei '(\.env$|secret|key.*\.json$|service.*account.*\.json$)' | grep -v '\.env\.example$' || true)
  if [ -z "$tracked" ]; then
    ok "no credential files are tracked in git"
  else
    bad "credential-looking files are TRACKED in git: $tracked"
  fi
else
  warn "not a git repository — skipped .gitignore verification"
fi

# --------------------------------------------------------------------------- #
step "Earth Engine live check"
if [ -x venv/bin/python ]; then
  if venv/bin/python -c 'import ee, fastapi' 2>/dev/null; then
    # One field per line, newlines collapsed, so shell parsing stays trivial.
    out=$(venv/bin/python -c "import backend.gee_client as g; r=g.diagnose(); f=lambda v: ' '.join((v or '').split()); print('STATUS='+f(r.get('gee_status'))); print('MESSAGE='+f(r.get('gee_message'))); print('FIX='+f(r.get('gee_fix'))); print('PROJECT='+f(r.get('gee_project')))" 2>&1)
    status=$(printf '%s\n' "$out" | sed -n 's/^STATUS=//p' | tail -1)
    msg=$(printf '%s\n' "$out" | sed -n 's/^MESSAGE=//p' | tail -1)
    fix=$(printf '%s\n' "$out" | sed -n 's/^FIX=//p' | tail -1)

    if [ "$status" = "ok" ]; then
      ok "GEE reachable — $msg"
    elif [ -z "$status" ]; then
      warn "health check produced no output (is the repo root the current directory?)"
    else
      printf '  %sFAIL%s  GEE status: %s\n' "$RED" "$OFF" "$status"
      printf '        %s%s%s\n' "$DIM" "${msg:-no message}" "$OFF"
      [ -n "${fix:-}" ] && printf '        %sfix: %s%s\n' "$DIM" "$fix" "$OFF"
      FAILURES=$((FAILURES + 1))
    fi
  else
    warn "backend dependencies not importable — skipped the live GEE check"
  fi
else
  warn "no venv — skipped the live GEE check"
fi

# --------------------------------------------------------------------------- #
step "Summary"
if [ "$FAILURES" -eq 0 ]; then
  printf '  %sALL CHECKS PASSED%s' "$GREEN$BOLD" "$OFF"
  [ "$WARNINGS" -gt 0 ] && printf ' (%s%d warning(s) — non-blocking%s)' "$YELLOW" "$WARNINGS" "$OFF"
  printf '\n  %sNext: start the backend and frontend (SETUP.md §7).%s\n' "$DIM" "$OFF"
  exit 0
else
  printf '  %s%d CHECK(S) FAILED%s — see the FAIL lines above and SETUP.md.\n' "$RED$BOLD" "$FAILURES" "$OFF"
  exit 1
fi
