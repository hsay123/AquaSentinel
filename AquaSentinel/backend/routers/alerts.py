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

            # Feed-level evidence: real before/after DATES plus the local
            # time-series chart. Imagery is rendered on demand via
            # GET /alerts/evidence, because rendering it here would issue
            # ~3 Earth Engine calls per flagged zone and stall the whole feed.
            evidence = generate_evidence_for_alert(
                flag,
                {},
                TS_STORE,
                BASELINE_STORE,
                EVIDENCE_DIR,
                render_imagery=False,
            )

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


@router.get("/evidence")
async def render_alert_evidence(
    waterbody_id: str = Query(...),
    zone_id: str = Query(...),
    date: str = Query(..., description="ISO date of the flagged observation"),
):
    """Render the real evidence pair for one flagged zone/date, on demand.

    Stateless (no alert id to look up) and cached on disk, so the alert feed can
    stay fast while the before/after imagery is produced only when a user
    actually opens an alert.
    """
    if waterbody_id not in WATERBODIES_REGISTRY:
        raise HTTPException(status_code=404, detail="Water body not found")

    df = TS_STORE.query(waterbody_id, zone_id)
    if df.empty:
        raise HTTPException(status_code=404, detail="No cached observations for that zone")

    import pandas as pd

    rows = df[pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d") == date]
    if rows.empty:
        raise HTTPException(
            status_code=404, detail=f"No cached observation for {zone_id} on {date}"
        )
    row = rows.iloc[-1]

    month = pd.Timestamp(date).month
    indicators = []
    for idx in ("ndti", "ndci", "fai"):
        value = row.get(idx)
        z = None
        try:
            baseline = BASELINE_STORE.get_baseline(waterbody_id, zone_id, idx, month)
            if baseline and value is not None and baseline[1]:
                z = (float(value) - float(baseline[0])) / float(baseline[1])
        except Exception:
            z = None
        indicators.append({
            "name": idx,
            "value": None if value is None else float(value),
            "z_score": z,
        })

    statistical = [
        i["name"] for i in indicators if i["z_score"] is not None and abs(i["z_score"]) >= 2
    ]
    from backend.pipeline.anomaly import AnomalyFlag

    max_abs_z = max((abs(i["z_score"]) for i in indicators if i["z_score"]), default=0.0)
    flag = AnomalyFlag(
        waterbody_id=waterbody_id,
        zone_id=zone_id,
        date=pd.Timestamp(date).date(),
        scene_id=str(row.get("scene_id") or ""),
        statistical_indices=statistical,
        confidence="high" if statistical else "needs_review",
        severity=min(1.0, (max_abs_z / 4.0) * (1 + 0.2 * len(statistical))),
    )

    evidence = generate_evidence_for_alert(
        flag,
        {},
        TS_STORE,
        BASELINE_STORE,
        EVIDENCE_DIR,
        aoi_geojson=WATERBODIES_REGISTRY[waterbody_id].aoi_geojson,
        render_imagery=True,
    )

    def _url(path):
        return f"/evidence-assets/{os.path.basename(path)}" if path else None

    return {
        "waterbody_id": waterbody_id,
        "zone_id": zone_id,
        "date": date,
        "indicators": indicators,
        "before_date": evidence.get("before_date"),
        "after_date": evidence.get("after_date"),
        "before_image_url": _url(evidence.get("before_truecolor_png_path")),
        "after_image_url": _url(evidence.get("after_truecolor_png_path")),
        "index_map_url": _url(evidence.get("index_map_png_path")),
        "chart_url": _url(evidence.get("chart_png_path")),
        "render_error": evidence.get("render_error"),
    }
