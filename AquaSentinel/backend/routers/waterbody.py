"""FastAPI router for waterbody endpoints."""

from __future__ import annotations

from datetime import date
from typing import Optional
from fastapi import APIRouter, HTTPException, Query

from backend.models.schemas import (
    WaterBodyCreate,
    WaterBodyResponse,
    ZoneResponse,
    TimeSeriesPoint,
    TimeSeriesResponse,
)
from backend.cache import get_demo_waterbodies
from backend.pipeline.timeseries_store import TimeseriesStore, BaselineStore
from backend.gee_client import check_connectivity
import os

router = APIRouter(prefix="/waterbodies", tags=["waterbodies"])

# In-memory registry (demo scope; a real deployment would use a database).
# Seeded from cache.DEMO_WATERBODIES — the locked AOIs in DEMO_AOIS.md. These are
# real monitoring sites, not synthetic stand-ins: the precomputed Parquet
# cache in data/ holds their real Sentinel-2 observations.
WATERBODIES_REGISTRY: dict[str, WaterBodyResponse] = dict(get_demo_waterbodies())

# Data store paths. AQUASENTINEL_DATA_ROOT may be relative; resolve it against
# the repo root so `./data` is found no matter which directory uvicorn was
# started from (running from backend/ used to silently create a second,
# empty data tree there).
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_data_root = os.environ.get("AQUASENTINEL_DATA_ROOT", "./data")
DATA_ROOT = _data_root if os.path.isabs(_data_root) else os.path.join(_REPO_ROOT, _data_root)
TS_STORE = TimeseriesStore(DATA_ROOT + "/timeseries")
BASELINE_STORE = BaselineStore(DATA_ROOT + "/baselines")


@router.get("", response_model=list[WaterBodyResponse])
async def list_waterbodies():
    """List all monitored water bodies."""
    return list(WATERBODIES_REGISTRY.values())


@router.get("/{waterbody_id}", response_model=WaterBodyResponse)
async def get_waterbody(waterbody_id: str):
    """Get a specific water body by ID."""
    if waterbody_id not in WATERBODIES_REGISTRY:
        raise HTTPException(status_code=404, detail="Water body not found")
    return WATERBODIES_REGISTRY[waterbody_id]


@router.post("", response_model=WaterBodyResponse)
async def create_waterbody(wb: WaterBodyCreate):
    """Register a new water body (admin/demo control)."""
    import uuid
    wb_id = str(uuid.uuid4())[:8]
    from datetime import datetime
    response = WaterBodyResponse(
        id=wb_id,
        name=wb.name,
        aoi_geojson=wb.aoi_geojson,
        description=wb.description,
        created_at=datetime.utcnow().isoformat(),
    )
    WATERBODIES_REGISTRY[wb_id] = response
    return response


@router.get("/{waterbody_id}/zones", response_model=list[ZoneResponse])
async def get_zones(waterbody_id: str):
    """Get zone grid geometry for a water body."""
    if waterbody_id not in WATERBODIES_REGISTRY:
        raise HTTPException(status_code=404, detail="Water body not found")

    # Load zones from timeseries store (they're created during ingestion)
    zone_ids = TS_STORE.get_all_zones(waterbody_id)
    if not zone_ids:
        raise HTTPException(status_code=404, detail="No zones found. Run ingestion first.")

    zones = []
    for zone_id in zone_ids:
        # Get zone info from first observation
        df = TS_STORE.query(waterbody_id, zone_id)
        if not df.empty:
            # We'd need to store zone geometry separately; for now reconstruct from data
            pass

    # For demo, return placeholder - real implementation would load from cached zone grid
    raise HTTPException(status_code=501, detail="Zone grid loading from cache not yet implemented")


@router.get("/{waterbody_id}/timeseries", response_model=TimeSeriesResponse)
async def get_timeseries(
    waterbody_id: str,
    zone_id: str = Query(...),
    index: str = Query(...),
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
):
    """Get time series data for a zone/index with baseline bands."""
    if waterbody_id not in WATERBODIES_REGISTRY:
        raise HTTPException(status_code=404, detail="Water body not found")

    df = TS_STORE.query(waterbody_id, zone_id, start_date, end_date)
    if df.empty:
        raise HTTPException(status_code=404, detail="No time series data found")

    # Load baselines
    baseline_df = BASELINE_STORE.load(waterbody_id)

    points = []
    for _, row in df.iterrows():
        # Get baseline for this index/month
        month = row["date"].month
        baseline = None
        if not baseline_df.empty:
            b = baseline_df[
                (baseline_df["zone_id"] == zone_id) &
                (baseline_df["index_name"] == index) &
                (baseline_df["month"] == month)
            ]
            if not b.empty:
                baseline = b.iloc[0]

        baseline_mean = float(baseline["mean"]) if baseline is not None else None
        baseline_std = float(baseline["std"]) if baseline is not None else None

        point = TimeSeriesPoint(
            date=row["date"].date() if hasattr(row["date"], "date") else row["date"],
            scene_id=row["scene_id"],
            ndti=row.get("ndti"),
            ndci=row.get("ndci"),
            fai=row.get("fai"),
            texture_score=row.get("texture_score"),
            cloud_pct=row["cloud_pct"],
            baseline_mean=baseline_mean,
            baseline_std=baseline_std,
            baseline_upper=baseline_mean + 2 * baseline_std if baseline_mean and baseline_std else None,
            baseline_lower=baseline_mean - 2 * baseline_std if baseline_mean and baseline_std else None,
            is_flagged=False,  # Would be set by anomaly detection
            z_score=None,
        )
        points.append(point)

    # Check if provisional (< 18 months history)
    date_range = df["date"].max() - df["date"].min()
    provisional = date_range.days < 540  # ~18 months

    return TimeSeriesResponse(
        waterbody_id=waterbody_id,
        zone_id=zone_id,
        index=index,
        points=points,
        provisional=provisional,
        n_scenes=len(df),
    )