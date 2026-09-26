"""AquaSentinel FastAPI application."""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.gee_client import GeeUnavailableError, diagnose, initialize as gee_initialize
from backend.routers import waterbody, alerts, ingest

logger = logging.getLogger("aquasentinel")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: resolve GEE auth and prove it with a real round-trip. The result
    # is logged loudly and kept on app.state so /health and the UI header can
    # report the *specific* reason GEE is unavailable, not just a boolean.
    app.state.gee = {"gee_connected": False, "gee_status": "unknown", "gee_message": "not checked"}
    try:
        auth_mode = gee_initialize()
        report = diagnose()
        app.state.gee = report
        if report["gee_connected"]:
            logger.info(
                "GEE ready — auth=%s project=%s", auth_mode, report.get("gee_project")
            )
        else:
            _log_gee_failure(report)
    except GeeUnavailableError:
        # initialize() already recorded a classified diagnosis before raising.
        # Falling through to the generic handler here would throw that away and
        # report a useless "unknown", so read the recorded report back.
        report = diagnose()
        app.state.gee = report
        _log_gee_failure(report)
    except Exception as exc:  # never let an unexpected error stop the server
        logger.error("GEE init raised an unexpected error: %s", exc, exc_info=True)
        app.state.gee = {
            "gee_connected": False,
            "gee_status": "unknown",
            "gee_message": str(exc),
            "gee_fix": "Unexpected error during GEE init — see the traceback in the backend logs.",
            "gee_auth_mode": None,
            "gee_project": None,
        }
        _log_gee_failure(app.state.gee)

    # Ensure data directories exist (resolved against the repo root so the
    # process CWD doesn't decide which data tree gets used)
    data_root = _data_root()
    os.makedirs(data_root + "/timeseries", exist_ok=True)
    os.makedirs(data_root + "/baselines", exist_ok=True)
    os.makedirs(data_root + "/evidence", exist_ok=True)

    yield

    # Shutdown (if needed)
    pass


def _data_root() -> str:
    """Absolute data root, so a teammate starting uvicorn from backend/ (or the
    repo root) ends up reading the same cache instead of silently creating a
    second empty one."""
    configured = os.environ.get("AQUASENTINEL_DATA_ROOT", "./data")
    if os.path.isabs(configured):
        return configured
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), configured)


def _log_gee_failure(report: dict) -> None:
    """Print the exact, actionable GEE failure at startup.

    Before this existed a broken machine only produced a silent "GEE Offline"
    badge, which forced the developer to guess whether the problem was auth,
    project access or the network.
    """
    logger.error("=" * 72)
    logger.error("GEE UNAVAILABLE — status: %s", report.get("gee_status"))
    logger.error("  reason: %s", report.get("gee_message"))
    if report.get("gee_fix"):
        logger.error("  fix:    %s", report["gee_fix"])
    logger.error("  project: %s   auth mode: %s", report.get("gee_project"), report.get("gee_auth_mode"))
    logger.error("  See SETUP.md for the full new-laptop sequence.")
    logger.error("=" * 72)


app = FastAPI(
    title="AquaSentinel API",
    description="Satellite-based water quality and contamination early-warning system",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS for frontend. FRONTEND_ORIGIN (comma-separated) adds deployed origins.
_allowed = ["http://localhost:5173", "http://127.0.0.1:5173"] + [
    o.strip() for o in os.environ.get("FRONTEND_ORIGIN", "").split(",") if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Include routers
app.include_router(waterbody.router)
app.include_router(alerts.router)
app.include_router(ingest.router)


@app.get("/health")
async def health_check():
    """Health check endpoint.

    Reports the *reason* GEE is unavailable, not just a boolean: a teammate with
    no credentials, expired credentials, a denied project and a blocked network
    each need a different fix, and the header badge surfaces these fields.
    """
    report = getattr(app.state, "gee", None) or diagnose()
    data_root = _data_root()
    cache_ok = os.path.exists(data_root + "/timeseries")
    gee_ok = bool(report.get("gee_connected"))

    return {
        "status": "ok" if gee_ok else "degraded",
        "gee_connected": gee_ok,
        "cache_available": cache_ok,
        # Diagnostic detail — additive, keeps `gee_connected` working for
        # anything already reading the old two-field shape.
        "gee_status": report.get("gee_status"),
        "gee_message": report.get("gee_message"),
        "gee_fix": report.get("gee_fix"),
        "gee_auth_mode": report.get("gee_auth_mode"),
        "gee_project": report.get("gee_project"),
    }


@app.get("/")
async def root():
    return {
        "name": "AquaSentinel",
        "description": "Satellite-based water quality & contamination early-warning system",
        "version": "0.1.0",
        "docs": "/docs",
    }