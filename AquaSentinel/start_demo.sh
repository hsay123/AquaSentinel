#!/bin/bash
# AquaSentinel Demo Startup Script
# Run from project root: ./start_demo.sh
#
# Everything runs from the repo root: the backend package is imported as
# `backend.*`, and data paths resolve relative to the root. Starting uvicorn
# from inside backend/ used to fail with ModuleNotFoundError, and the venv used
# to live at backend/venv while the README told you to create it at backend/venv
# and then run `cd backend && uvicorn main:app` — which never worked.

set -uo pipefail
cd "$(dirname "$0")"

SKIP_PRECOMPUTE=false

for arg in "$@"; do
    case $arg in
        --skip-precompute) SKIP_PRECOMPUTE=true; shift ;;
        --live) shift ;;
    esac
done

PY="venv/bin/python"

echo "========================================"
echo "  AquaSentinel Demo Startup"
echo "========================================"
echo ""

# Check prerequisites
echo "Checking prerequisites..."

if [ ! -x "$PY" ]; then
    echo "Creating Python venv..."
    python3 -m venv venv
    "$PY" -m pip install -q --upgrade pip
    "$PY" -m pip install -q -r backend/requirements.txt
fi
echo "Python env: $("$PY" --version 2>&1)"

if [ ! -d "frontend/node_modules" ]; then
    echo "Installing frontend dependencies..."
    (cd frontend && npm install)
fi

# GEE auth check — uses the same diagnosis the backend uses, so this message
# matches what the UI header will show.
echo ""
echo "Checking GEE authentication..."
GEE_LINE=$("$PY" -c "import backend.gee_client as g; r=g.diagnose(); f=lambda v: ' '.join((v or '').split()); print('STATUS='+f(r.get('gee_status'))); print('MESSAGE='+f(r.get('gee_message'))); print('FIX='+f(r.get('gee_fix')))" 2>/dev/null)
GEE_STATUS=$(printf '%s\n' "$GEE_LINE" | sed -n 's/^STATUS=//p' | tail -1)
GEE_MSG=$(printf '%s\n' "$GEE_LINE" | sed -n 's/^MESSAGE=//p' | tail -1)
GEE_FIX=$(printf '%s\n' "$GEE_LINE" | sed -n 's/^FIX=//p' | tail -1)

if [ "$GEE_STATUS" = "ok" ]; then
    echo "GEE authenticated: $GEE_MSG"
else
    echo "WARNING: GEE unavailable (status: ${GEE_STATUS:-unknown})"
    echo "  reason: ${GEE_MSG:-unknown}"
    [ -n "${GEE_FIX:-}" ] && echo "  fix:    $GEE_FIX"
    echo "  See SETUP.md. Continuing anyway so the UI can show the specific reason."
fi

# Run precompute if needed
if [ "$SKIP_PRECOMPUTE" = false ]; then
    if [ ! -d "data/timeseries" ] || [ -z "$(ls -A data/timeseries 2>/dev/null)" ]; then
        echo ""
        echo "Running precompute (fetches real Sentinel-2 data from GEE)..."
        echo "This may take 5-15 minutes depending on GEE quota..."
        if ! "$PY" -m backend.scripts.precompute; then
            echo "ERROR: Precompute failed. Check GEE quota and authentication."
            exit 1
        fi
    else
        echo "Cache found, skipping precompute. Use --skip-precompute to skip this check."
    fi
fi

# Start backend (from the repo root so `backend.*` imports resolve)
echo ""
echo "Starting backend on http://localhost:8000..."
"$PY" -m uvicorn backend.main:app --reload --port 8000 &
BACKEND_PID=$!

# Wait for the backend to answer /health before starting the frontend, so the
# "Failed to load waterbodies" banner never flashes on a cold start.
sleep 3
for _ in $(seq 1 20); do
    curl -sf http://localhost:8000/health >/dev/null 2>&1 && break
    sleep 1
done

# Start frontend
echo "Starting frontend on http://localhost:5173..."
(cd frontend && npm run dev) &
FRONTEND_PID=$!

echo ""
echo "========================================"
echo "  Demo Ready!"
echo "========================================"
echo ""
echo "Frontend: http://localhost:5173"
echo "Backend API: http://localhost:8000"
echo "API Docs: http://localhost:8000/docs"
echo ""
echo "Confirm the header reads 'GEE Connected' before demoing."
echo "Press Ctrl+C to stop both servers"

trap 'echo ""; echo "Stopping servers..."; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0' INT TERM

wait $BACKEND_PID $FRONTEND_PID
