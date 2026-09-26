"""Google Earth Engine client initialization, authentication, and health diagnosis.

Authentication sources are resolved in this order (first match wins):

  1. ``GEE_SERVICE_ACCOUNT_EMAIL`` + ``GEE_SERVICE_ACCOUNT_KEY_PATH``
     -> ``ee.ServiceAccountCredentials(email, key_file)``.
     This is the portable option: the same key works on every laptop, every
     teammate and every CI run, and it never depends on per-user state in
     ``$HOME``. Preferred for the team.
  2. ``EE_CREDENTIALS_JSON``
     -> the raw JSON blob of a personal OAuth credential, rehydrated into the
     path the ``ee`` client reads by default. Used for single-host deploys
     (e.g. a Render service) that can't mount a key file.
  3. ``~/.config/earthengine/credentials`` (Windows: ``%APPDATA%\\earthengine\\credentials``)
     -> whatever ``earthengine authenticate`` / ``ee.Authenticate()`` wrote.
     Per-machine personal state; convenient for solo local dev, never portable.
  4. Google Application Default Credentials, if the environment provides them.

If none of those yield a usable credential, :func:`diagnose` explains *which*
one is missing and *how* to fix it, instead of the bare "GEE Offline" badge.
"""

from __future__ import annotations

import json
import logging
import os
import socket
import sys
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from pathlib import Path
from typing import Any, Optional

from dotenv import load_dotenv

# Load .env from the repo root before anything reads os.environ. No-op when the
# file is absent (fresh clone that hasn't run `cp .env.example .env` yet) — the
# diagnosis then reports exactly which variable is missing.
_REPO_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(_REPO_ROOT / ".env")

import ee  # noqa: E402  (imported after load_dotenv on purpose)

logger = logging.getLogger("aquasentinel.gee")

#: Default GEE Cloud project. Override per-machine with GEE_PROJECT_ID in .env
#: rather than editing code — a teammate on a different Cloud project must be
#: able to change this without a code change.
DEFAULT_GEE_PROJECT_ID = "project-326ab593-31e9-43ed-8cd"

#: Where `earthengine authenticate` writes on this OS. Used to tell "never
#: authenticated on this machine" apart from "authenticated but rejected".
def _default_credentials_path() -> Path:
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(base) / "earthengine" / "credentials"
    return Path.home() / ".config" / "earthengine" / "credentials"


#: Failure categories surfaced to /health and the header badge. Each maps to a
#: different fix, which is why they are distinguished rather than collapsed
#: into a single boolean.
STATUS_OK = "ok"
STATUS_NO_CREDENTIALS = "no_credentials"
STATUS_SERVICE_ACCOUNT_MISCONFIGURED = "service_account_misconfigured"
STATUS_INVALID_CREDENTIALS = "invalid_credentials"
STATUS_PROJECT_DENIED = "project_denied"
STATUS_NETWORK = "network_unreachable"
STATUS_TIMEOUT = "network_timeout"
STATUS_UNKNOWN = "unknown"

#: Short, typed-into-your-editor fix for each status. Deliberately one line per
#: status so the header badge and /health can show the *next action* rather than
#: a restatement of the error.
_STATUS_FIX_HINTS: dict[str, str] = {
    STATUS_NO_CREDENTIALS: (
        "Set GEE_SERVICE_ACCOUNT_EMAIL and GEE_SERVICE_ACCOUNT_KEY_PATH in .env and "
        "place the key file (ask the repo owner — SETUP.md step 5). Solo dev "
        "alternative: run 'earthengine authenticate' once on this machine."
    ),
    STATUS_SERVICE_ACCOUNT_MISCONFIGURED: (
        "Fix the GEE_SERVICE_ACCOUNT_* values in .env — the backend log names the "
        "exact mismatch (missing key file, wrong path, or a JSON file that is not a "
        "service account key)."
    ),
    STATUS_INVALID_CREDENTIALS: (
        "The key was revoked or rotated in Google Cloud — request a fresh key from "
        "the repo owner. Re-running 'earthengine authenticate' does not help a "
        "service account."
    ),
    STATUS_PROJECT_DENIED: (
        "The credential authenticated but Earth Engine refused the project. Either "
        "the project is not registered for Earth Engine "
        "(https://code.earthengine.google.com/register — takes a few minutes to "
        "propagate) or the account has no 'Earth Engine User' role on it. Grant the "
        "role, or point GEE_PROJECT_ID in .env at a project the account can use."
    ),
    STATUS_NETWORK: (
        "Network problem, not an auth problem: allow "
        "earthengine.googleapis.com through the VPN/firewall/proxy, then retry."
    ),
    STATUS_TIMEOUT: (
        "Earth Engine is reachable but slow. Retry, or allowlist the GEE hosts if a "
        "proxy is intercepting them."
    ),
    STATUS_UNKNOWN: "Check the backend startup log for the full traceback.",
}

_initialized = False
_auth_mode: Optional[str] = None
_last_diagnosis: Optional[dict[str, Any]] = None


class GeeUnavailableError(RuntimeError):
    """Raised when GEE cannot be reached or the project is not authorized.

    Carries the failure ``status`` (one of the ``STATUS_*`` constants) so callers
    that only see the exception can still report the specific reason.
    """

    def __init__(self, message: str, status: str = STATUS_UNKNOWN):
        super().__init__(message)
        self.status = status


# --------------------------------------------------------------------------- #
# Credential sourcing
# --------------------------------------------------------------------------- #

def _restore_credentials_from_env() -> bool:
    """Write credentials JSON from an env var to the on-disk path ``ee`` reads.

    Returns True if a credential file was written. Used for the
    ``EE_CREDENTIALS_JSON`` deploy path (source 2 above).
    """
    raw = os.environ.get("EE_CREDENTIALS_JSON", "").strip()
    if not raw:
        return False
    cred_path = _default_credentials_path()
    cred_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise GeeUnavailableError(
            f"EE_CREDENTIALS_JSON is not valid JSON: {exc}. "
            "It must be the verbatim contents of ~/.config/earthengine/credentials."
        ) from exc
    cred_path.write_text(json.dumps(parsed))
    logger.info("Restored Earth Engine credentials from EE_CREDENTIALS_JSON -> %s", cred_path)
    return True


def _service_account_config() -> tuple[Optional[str], Optional[Path], Optional[str]]:
    """Resolve (email, key_path, error) from the GEE_SERVICE_ACCOUNT_* env vars.

    Returns an ``error`` string instead of raising so the caller can report a
    precise, actionable diagnosis (a half-configured service account is the most
    common setup mistake and deserves its own message).
    """
    email = os.environ.get("GEE_SERVICE_ACCOUNT_EMAIL", "").strip()
    raw_path = os.environ.get("GEE_SERVICE_ACCOUNT_KEY_PATH", "").strip()

    if not email and not raw_path:
        return None, None, None  # service account not requested at all

    if not email:
        return None, None, (
            "GEE_SERVICE_ACCOUNT_EMAIL is not set. A service account key was "
            "requested (GEE_SERVICE_ACCOUNT_KEY_PATH is set) but the account "
            "email is missing. Set both, or unset both to fall back to a "
            "personal 'earthengine authenticate' login."
        )
    if not raw_path:
        return None, None, (
            "GEE_SERVICE_ACCOUNT_KEY_PATH is not set. Set it to the path of the "
            "service account JSON key (e.g. ./secrets/gee-key.json), or unset "
            "both GEE_SERVICE_ACCOUNT_* variables to use a personal login."
        )
    if not email.endswith(".gserviceaccount.com"):
        return None, None, (
            f"GEE_SERVICE_ACCOUNT_EMAIL ('{email}') is not a Google service account "
            "address. It must look like 'name@project.iam.gserviceaccount.com'."
        )

    # Resolve relative paths against the repo root so './secrets/gee-key.json'
    # works no matter which directory uvicorn was launched from.
    key_path = Path(raw_path).expanduser()
    if not key_path.is_absolute():
        key_path = (_REPO_ROOT / key_path).resolve()
    if not key_path.exists():
        return None, None, (
            f"GEE service account key file not found at {key_path}. Ask the repo "
            "owner for the key (see SETUP.md step 5) and place it there, or point "
            "GEE_SERVICE_ACCOUNT_KEY_PATH at the correct path."
        )
    try:
        key = json.loads(key_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return None, None, (
            f"GEE service account key file at {key_path} could not be read as JSON: {exc}. "
            "Re-download the key from the Google Cloud console — a truncated or "
            "HTML error page saved as .json is the usual cause."
        )
    if key.get("type") != "service_account":
        looks_personal = bool(key.get("refresh_token")) or (
            "private_key" not in key and "client_id" in key
        )
        hint = (
            " This looks like a personal OAuth credentials file — download the key "
            "for the service account from the Google Cloud console instead."
            if looks_personal
            else " Re-download the key for the service account."
        )
        return None, None, (
            f"The file at {key_path} is not a service account key "
            f"(found \"type\": {key.get('type')!r}, expected 'service_account')." + hint
        )
    if key.get("client_email") != email:
        return None, None, (
            f"GEE_SERVICE_ACCOUNT_KEY_PATH points at a key for "
            f"'{key.get('client_email')}' but GEE_SERVICE_ACCOUNT_EMAIL is "
            f"'{email}'. Make the email in .env match the key file."
        )
    return email, key_path, None


def _resolve_credentials() -> str:
    """Return the auth mode actually used, or raise GeeUnavailableError.

    Modes: ``service_account`` | ``credentials_json`` | ``user_credentials`` |
    ``application_default``.
    """
    email, key_path, error = _service_account_config()
    if error is not None:
        raise GeeUnavailableError(error, STATUS_SERVICE_ACCOUNT_MISCONFIGURED)
    if email and key_path:
        credentials = ee.ServiceAccountCredentials(email, str(key_path))
        logger.info("Using GEE service account credentials (%s)", email)
        return "service_account"

    if _restore_credentials_from_env():
        return "credentials_json"

    if _default_credentials_path().exists():
        logger.info("Using Earth Engine user credentials at %s", _default_credentials_path())
        return "user_credentials"

    # Last resort: ADC from the environment (GCP_WORKLOAD_IDENTITY, gcloud, CI).
    try:
        import google.auth  # provided by the earthengine-api dependency chain

        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        if creds is not None:
            logger.info("Using Google Application Default Credentials")
            return "application_default"
    except Exception:  # pragma: no cover - depends on ambient environment
        pass

    raise GeeUnavailableError(
        "No Google Earth Engine credentials found for this machine.\n"
        "  Fix (recommended for the team): ask the repo owner for the GEE service "
        "account key, then set GEE_SERVICE_ACCOUNT_EMAIL and "
        "GEE_SERVICE_ACCOUNT_KEY_PATH in .env (see .env.example).\n"
        "  Fix (solo local dev only): run 'earthengine authenticate' once on this "
        "machine, then retry. Note that this writes to your home directory and "
        "will NOT travel to another laptop or to CI.",
        STATUS_NO_CREDENTIALS,
    )


# --------------------------------------------------------------------------- #
# Failure classification
# --------------------------------------------------------------------------- #

def _classify(exc: BaseException) -> tuple[str, str, str]:
    """Map an exception to (status, message, fix) — the three things a teammate
    needs: what broke, why, and what to type next.
    """
    text = str(exc).strip()
    low = text.lower()

    # Network-level failures: DNS, TLS, refused, unreachable. Distinguished from
    # auth failures because retrying/re-authorizing does not help.
    if isinstance(exc, (socket.gaierror, ConnectionError, TimeoutError, OSError)) and not isinstance(exc, RuntimeError):
        return (
            STATUS_NETWORK,
            f"Cannot reach Google Earth Engine: {text}",
            "This machine cannot open a connection to earthengine.googleapis.com. "
            "Check your network / VPN / proxy, then re-run the health check.",
        )
    if "max retries exceeded" in low or "connection refused" in low or "failed to establish" in low:
        return (
            STATUS_NETWORK,
            f"Cannot reach Google Earth Engine: {text}",
            "Network or proxy problem, not an auth problem. Check VPN/firewall, "
            "then re-run the health check.",
        )

    # Missing credentials — the message ee raises when nobody has authorized.
    if "please authorize access to your earth engine account" in low or "not been authenticated" in low:
        return (
            STATUS_NO_CREDENTIALS,
            "Earth Engine is not authenticated on this machine.",
            "Set GEE_SERVICE_ACCOUNT_EMAIL + GEE_SERVICE_ACCOUNT_KEY_PATH in .env "
            "(recommended), or run 'earthengine authenticate' locally for solo dev.",
        )

    # Credentials present but rejected.
    if any(k in low for k in (
        "invalid_grant", "invalid credentials", "credentials are invalid",
        "token has been expired or revoked", "unauthorized", "401",
        "reauthentication", "could not fetch access token", "invalid_grant_error",
    )):
        return (
            STATUS_INVALID_CREDENTIALS,
            f"Earth Engine rejected the credentials: {text}",
            "The credential is present but no longer valid. For a service account, "
            "the key was revoked/rotated in Google Cloud — request a fresh key. "
            "For a personal login, re-run 'earthengine authenticate'.",
        )

    # Authenticated, but the request was refused for this project. GEE phrases
    # this several ways depending on whether the caller presented a token at
    # all, a token for an unregistered project, or a token whose account lacks
    # the Earth Engine role.
    if any(k in low for k in (
        "permission denied", "not found or permission", "forbidden", "403",
        "does not have permission", "user is not authorized",
        "missing required authentication credential",
        "expected oauth 2 access token",
    )):
        return (
            STATUS_PROJECT_DENIED,
            f"Earth Engine access to the configured project was denied: {text}",
            "The credential works but has no access to GEE_PROJECT_ID. Grant the "
            "account the 'Earth Engine User' role on that Cloud project (service "
            "accounts need the role explicitly, and it can take a few minutes to "
            "propagate), or set GEE_PROJECT_ID in .env to a project you can access.",
        )

    if "timed out" in low or "timeout" in low:
        return (
            STATUS_TIMEOUT,
            f"Earth Engine did not respond in time: {text}",
            "Network reachable but slow/blocked. Retry, or check for a proxy that "
            "allows earthengine.googleapis.com.",
        )

    return (STATUS_UNKNOWN, text or type(exc).__name__, "See the backend startup log for the full traceback.")


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #

def project_id() -> str:
    """The GEE Cloud project this process authenticates against."""
    return os.environ.get("GEE_PROJECT_ID", "").strip() or DEFAULT_GEE_PROJECT_ID


def initialize(project: Optional[str] = None) -> str:
    """Initialize the Earth Engine session exactly once per process.

    Returns the auth mode used. Raises :class:`GeeUnavailableError` with an
    actionable message when no usable credential or project access exists.
    """
    global _initialized, _auth_mode
    if _initialized:
        return _auth_mode or "unknown"

    project = project or project_id()

    # Surface a half-configured service account before touching the network, so
    # the common misconfiguration reports the misconfiguration, not a 401.
    try:
        mode = _resolve_credentials()
    except GeeUnavailableError as exc:
        _fail(str(exc), project, status=exc.status)
        raise

    # NOTE: only pass `credentials` when we actually built service-account
    # credentials. earthengine-api uses the *string* sentinel 'persistent' to
    # mean "load credentials from disk"; passing an explicit None skips that
    # discovery, and because a valid `project` still satisfies its no-project
    # guard, the failure surfaces much later as a confusing 401
    # CREDENTIALS_MISSING instead of a clear auth error.
    init_kwargs: dict[str, Any] = {"project": project}
    sa_credentials = _service_account_credentials()
    if sa_credentials is not None:
        init_kwargs["credentials"] = sa_credentials

    try:
        ee.Initialize(**init_kwargs)
    except Exception as exc:
        status, message, fix = _classify(exc)
        _fail(f"{message} ({project})", project, status=status, auth_mode=mode)
        raise GeeUnavailableError(
            f"{message}\n  Fix: {fix}\n  (project: {project}, auth: {mode})",
            status,
        ) from exc
    _initialized = True
    _auth_mode = mode
    return mode


def _service_account_credentials():
    """Build service-account credentials when configured, else None (ee picks
    up whatever ``_resolve_credentials`` already staged on disk)."""
    email, key_path, error = _service_account_config()
    if error is not None or not (email and key_path):
        return None
    return ee.ServiceAccountCredentials(email, str(key_path))


def _fail(message: str, project: str, status: Optional[str] = None,
          auth_mode: Optional[str] = "none") -> None:
    """Record + log a diagnosis. Keeps /health and the startup log in sync."""
    global _last_diagnosis
    classified_status, _, classified_fix = _classify(RuntimeError(message))
    status = status or classified_status
    fix = _STATUS_FIX_HINTS.get(status, classified_fix)
    _last_diagnosis = {
        "gee_connected": False,
        "gee_status": status,
        "gee_message": message,
        "gee_fix": fix,
        "gee_auth_mode": auth_mode,
        "gee_project": project,
    }
    logger.error("Earth Engine unavailable (%s, auth=%s): %s", status, auth_mode, message)


def check_connectivity(project: Optional[str] = None, timeout_s: float = 8.0) -> bool:
    """Return True if GEE is reachable and responds to a trivial request.

    The probe runs on a worker thread with a hard ``timeout_s`` so a GEE network
    outage can never wedge the server (the ``ee`` client has no read timeout of
    its own and would otherwise hang startup / health for minutes).
    """
    global _last_diagnosis
    project = project or project_id()
    mode = initialize(project)

    def _probe() -> bool:
        # Cheap round-trip that proves auth + network + project access.
        return ee.Number(1).add(1).getInfo() == 2

    pool = ThreadPoolExecutor(max_workers=1)
    try:
        future = pool.submit(_probe)
        try:
            ok = future.result(timeout=timeout_s)
            if ok:
                _last_diagnosis = {
                    "gee_connected": True,
                    "gee_status": STATUS_OK,
                    "gee_message": f"Earth Engine reachable via {mode} (project {project}).",
                    "gee_fix": None,
                    "gee_auth_mode": mode,
                    "gee_project": project,
                }
                return True
            status, message, fix = (
                STATUS_UNKNOWN,
                "Earth Engine probe returned an unexpected value.",
                "Retry; if it persists, re-check your GEE project quota.",
            )
        except FutureTimeout:
            status = STATUS_TIMEOUT
            message = f"Earth Engine did not respond within {timeout_s:.0f}s."
            fix = ("Network reachable but slow or blocked. Retry, or check that a proxy "
                   "allows earthengine.googleapis.com.")
        except Exception as exc:
            status, message, fix = _classify(exc)
    finally:
        # Never block on the abandoned probe thread (GEE has no read timeout).
        pool.shutdown(wait=False)

    _last_diagnosis = {
        "gee_connected": False,
        "gee_status": status,
        "gee_message": message,
        "gee_fix": fix,
        "gee_auth_mode": mode,
        "gee_project": project,
    }
    logger.error("Earth Engine health probe failed (%s): %s", status, message)
    return False


def diagnose() -> dict[str, Any]:
    """Structured GEE health, safe to call whether or not init has been tried.

    Always returns the same keys so the frontend can render them unconditionally.
    """
    global _last_diagnosis
    if _last_diagnosis is not None:
        return dict(_last_diagnosis)
    try:
        ok = check_connectivity()
    except GeeUnavailableError as exc:
        # check_connectivity re-raises after recording a diagnosis; surface it.
        return dict(_last_diagnosis or {
            "gee_connected": False,
            "gee_status": STATUS_UNKNOWN,
            "gee_message": str(exc),
            "gee_fix": "See the backend startup log for the full traceback.",
            "gee_auth_mode": None,
            "gee_project": project_id(),
        })
    return dict(_last_diagnosis or {
        "gee_connected": ok,
        "gee_status": STATUS_UNKNOWN if not ok else STATUS_OK,
        "gee_message": "No Earth Engine diagnosis has been run yet.",
        "gee_fix": None,
        "gee_auth_mode": None,
        "gee_project": project_id(),
    })


def reset() -> None:
    """Clear cached init/diagnosis state (tests, and re-auth without a restart)."""
    global _initialized, _auth_mode, _last_diagnosis
    _initialized = False
    _auth_mode = None
    _last_diagnosis = None
