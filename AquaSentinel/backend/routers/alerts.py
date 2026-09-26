"""FastAPI router for alerts endpoints."""

from __future__ import annotations

from datetime import date
from typing import Optional
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
import os

from backend.models.schemas import AlertFeedResponse, AlertResponse
from backend.pipeline.timeseries_store import TimeseriesStore
from backend.pipeline.anomaly import detect_anomalies_all_zones
from backend.pipeline.alerts import build_alert, generate_evidence_for_alert
from backend.pipeline.explain import generate_explanation, llm_polish_explanation
from backend.routers.waterbody import TS_STORE, BASELINE_STORE, WATERBODIES_REGISTRY

router = APIRouter(prefix="/alerts", tags=["alerts"])

DATA_ROOT = os.environ.get("AQUASENTINEL_DATA_ROOT", "./data")
EVIDENCE_DIR = DATA_ROOT + "/evidence"


@router.get("", response_model=AlertFeedResponse)
async def get_alerts(
    waterbody_id: str = Query(...),
    since: Optional[date] = None,
    confidence: Optional[str] = None,  # "high" | "needs_review"
    min_severity: float = 0.0,
):
    """Get alert feed for a water body."""
    if waterbody_id not in WATERBODIES_REGISTRY:
        raise HTTPException(status_code=404, detail="Water body not found")

    # Get all zones for this waterbody
    zone_ids = TS_STORE.get_all_zones(waterbody_id)
    if not zone_ids:
        return AlertFeedResponse(alerts=[], waterbody_id=waterbody_id, since=since, count=0)

    # For each zone, get latest observations and run anomaly detection
    all_alerts = []

    for zone_id in zone_ids:
        # Get recent observations
        df = TS_STORE.query(waterbody_id, zone_id, since)
        if df.empty:
            continue

        # Run anomaly detection on recent data
        # Note: In production, this would be precomputed and stored
        flags = detect_anomalies_all_zones(
            waterbody_id,
            df,
            TS_STORE,
            BASELINE_STORE,
        )

        for flag in flags:
            if flag.confidence == "none":
                continue
            if confidence and flag.confidence != confidence:
                continue
            if flag.severity < min_severity:
                continue

            # Build indicator details for explanation
            indicators_detail = []
            for idx_name in ["ndti", "ndci", "fai", "texture_score"]:
                z_key = f"{idx_name}_z"
                z_val = getattr(flag, z_key, None)
                if z_val is not None:
                    indicators_detail.append({
                        "name": idx_name,
                        "value": getattr(flag, idx_name.replace("_z", ""), 0) or 0,
                        "baseline_mean": None,  # Would come from baseline store
                        "baseline_std": None,
                        "z_score": z_val,
                    })

            # Generate explanation
            raw_explanation = generate_explanation(flag, indicators_detail)

            # Optional LLM polish
            groq_key = os.environ.get("GROQ_API_KEY")
            explanation, generated = llm_polish_explanation(raw_explanation, groq_key)

            # Generate evidence (placeholder paths)
            evidence = generate_evidence_for_alert(flag, {}, TS_STORE, BASELINE_STORE, EVIDENCE_DIR)

            # Build alert
            alert = build_alert(
                flag=flag,
                zone_polygon={},  # Would come from zone grid cache
                indicators_detail=indicators_detail,
                evidence_paths=evidence,
            )
            alert.explanation = explanation
            alert.generated = generated
            all_alerts.append(AlertResponse(**alert.to_dict()))

    # Sort by date descending (newest first)
    all_alerts.sort(key=lambda a: a.date, reverse=True)

    return AlertFeedResponse(
        alerts=all_alerts,
        waterbody_id=waterbody_id,
        since=since,
        count=len(all_alerts),
    )


@router.get("/{alert_id}", response_model=AlertResponse)
async def get_alert(alert_id: str, waterbody_id: str = Query(...)):
    """Get a specific alert by ID."""
    # In a real implementation, alerts would be stored with IDs
    # For demo, we recompute
    feed = await get_alerts(waterbody_id=waterbody_id)
    for alert in feed.alerts:
        if alert.id == alert_id:
            return alert
    raise HTTPException(status_code=404, detail="Alert not found")


@router.get("/{alert_id}/evidence")
async def get_alert_evidence(alert_id: str, waterbody_id: str = Query(...)):
    """Get evidence images for an alert."""
    alert_response = await get_alert(alert_id, waterbody_id)
    evidence = alert_response.evidence

    # Return the index map PNG
    if evidence.index_map_png_path and os.path.exists(evidence.index_map_png_path):
        return FileResponse(evidence.index_map_png_path, media_type="image/png")
    raise HTTPException(status_code=404, detail="Evidence image not found")