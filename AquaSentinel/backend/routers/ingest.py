"""FastAPI router for ingestion endpoints."""

from __future__ import annotations

from datetime import date
from fastapi import APIRouter, HTTPException, Query

from backend.models.schemas import IngestRunRequest, IngestRunResponse
from backend.routers.waterbody import WATERBODIES_REGISTRY, TS_STORE, BASELINE_STORE
from backend.pipeline.timeseries_store import TimeseriesStore, BaselineStore
from backend.pipeline.anomaly import detect_anomalies_all_zones
from backend.pipeline.alerts import build_alert, generate_evidence_for_alert
from backend.pipeline.explain import generate_explanation, llm_polish_explanation
import os

router = APIRouter(prefix="/ingest", tags=["ingest"])

DATA_ROOT = os.environ.get("AQUASENTINEL_DATA_ROOT", "./data")
EVIDENCE_DIR = DATA_ROOT + "/evidence"


@router.post("/run", response_model=IngestRunResponse)
async def run_ingestion(request: IngestRunRequest):
    """Trigger batch ingestion for a water body.

    In demo mode (live=false), reads from pre-cached Parquet store.
    In live mode (live=true), calls GEE directly.
    """
    if request.waterbody_id not in WATERBODIES_REGISTRY:
        raise HTTPException(status_code=404, detail="Water body not found")

    wb = WATERBODIES_REGISTRY[request.waterbody_id]

    if request.live:
        # Live GEE path - would call the full pipeline
        raise HTTPException(status_code=501, detail="Live GEE ingestion not yet implemented")
    else:
        # Demo mode: data should already be cached
        zone_ids = TS_STORE.get_all_zones(request.waterbody_id)
        if not zone_ids:
            raise HTTPException(
                status_code=404,
                detail="No cached data found. Run the precompute script first."
            )

        # Count scenes in cache
        total_scenes = 0
        for zid in zone_ids:
            df = TS_STORE.query(request.waterbody_id, zid)
            total_scenes += len(df)

        # Run anomaly detection on latest data to generate alerts
        alerts_generated = 0
        for zone_id in zone_ids:
            df = TS_STORE.query(request.waterbody_id, zone_id)
            if not df.empty:
                flags = detect_anomalies_all_zones(
                    request.waterbody_id,
                    df.tail(1),  # Only check latest observation
                    TS_STORE,
                    BASELINE_STORE,
                )
                alerts_generated += len([f for f in flags if f.confidence != "none"])

        return IngestRunResponse(
            status="completed",
            waterbody_id=request.waterbody_id,
            scenes_processed=total_scenes,
            zones_processed=len(zone_ids),
            alerts_generated=alerts_generated,
            message="Demo mode: read from cached Parquet store",
            cached=True,
        )